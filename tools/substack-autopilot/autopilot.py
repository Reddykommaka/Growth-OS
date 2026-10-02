"""
Substack Autopilot
Picks a topic -> writes a post with Claude -> creates a Substack draft (or publishes it).

Modes (PUBLISH_MODE env var):
  dry      - generate only, save Markdown to posts/, don't touch Substack
  draft    - create a Substack draft (default, safest)
  publish  - create and publish immediately
"""

import datetime
import json
import os
import pathlib
import re
import sys
import tempfile

from anthropic import Anthropic

ROOT = pathlib.Path(__file__).parent
TOPICS_FILE = ROOT / "topics.txt"
LOG_FILE = ROOT / "published.jsonl"
POSTS_DIR = ROOT / "posts"


# ---------- config ----------

def env(name, default=None, required=False):
    val = os.getenv(name) or default  # empty counts as unset (CI passes unset vars as "")
    if required and not val:
        sys.exit(f"Missing required env var: {name}")
    return val


MODE = env("PUBLISH_MODE", "draft").lower()
MODEL = env("CLAUDE_MODEL", "claude-sonnet-5-5")
NICHE = env("BLOG_NICHE", "AI tools and productivity for solo builders")
AUDIENCE = env("BLOG_AUDIENCE", "indie hackers, creators and small business owners")
VOICE = env("BLOG_VOICE", "clear, practical, friendly, no hype, short paragraphs")
WORDS = int(env("WORD_COUNT", "900"))
SEND_EMAIL = env("SEND_EMAIL", "false").lower() == "true"

if MODE not in ("dry", "draft", "publish"):
    sys.exit(f"PUBLISH_MODE must be dry, draft or publish (got {MODE!r})")


# ---------- topics ----------

def read_topics():
    if not TOPICS_FILE.exists():
        return []
    return [l.strip() for l in TOPICS_FILE.read_text().splitlines()
            if l.strip() and not l.strip().startswith("#")]


def remove_topic(topic):
    lines = TOPICS_FILE.read_text().splitlines()
    removed = False
    kept = []
    for line in lines:
        if not removed and line.strip() == topic:
            removed = True
            continue
        kept.append(line)
    TOPICS_FILE.write_text("\n".join(kept) + "\n")


def recent_titles(n=40):
    if not LOG_FILE.exists():
        return []
    rows = [json.loads(l) for l in LOG_FILE.read_text().splitlines() if l.strip()]
    return [r["title"] for r in rows[-n:]]


# ---------- generation ----------

SYSTEM = f"""You write daily blog posts for a Substack newsletter.
Niche: {NICHE}
Audience: {AUDIENCE}
Voice: {VOICE}

Rules:
- Original, specific, useful. Concrete examples over generic advice.
- Never invent statistics, quotes, studies, or named sources.
- Use Markdown: ## subheadings, short paragraphs, occasional lists.
- Do NOT repeat the title inside the body.
- Return ONLY a JSON object, no code fences, with keys:
  "title" (under 70 chars), "subtitle" (one line), "body" (Markdown)."""


def parse_json(text):
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end < start:
        raise ValueError("no JSON object in response")
    return json.loads(text[start:end + 1])


def generate_post(topic):
    client = Anthropic(api_key=env("ANTHROPIC_API_KEY", required=True))
    avoid = recent_titles()
    if topic:
        ask = f"Write a ~{WORDS}-word post on this topic: {topic}"
    else:
        ask = (f"Pick a fresh, specific topic in the niche and write a ~{WORDS}-word post. "
               "Don't overlap with these recent titles:\n- " + "\n- ".join(avoid or ["(none yet)"]))

    last_err = None
    for _ in range(2):  # one retry if JSON comes back malformed
        msg = client.messages.create(
            model=MODEL,
            max_tokens=4000,
            system=SYSTEM,
            messages=[{"role": "user", "content": ask}],
        )
        if msg.stop_reason == "max_tokens":
            last_err = "response hit max_tokens before the JSON closed"
            continue
        text = "".join(b.text for b in msg.content if b.type == "text")
        try:
            post = parse_json(text)
        except Exception as e:  # noqa: BLE001
            last_err = e
            continue
        missing = [k for k in ("title", "subtitle", "body") if not post.get(k)]
        if not missing:
            return post
        last_err = f"missing keys: {', '.join(missing)}"
    sys.exit(f"Claude didn't return a valid post: {last_err}")


def save_markdown(post):
    POSTS_DIR.mkdir(exist_ok=True)
    slug = re.sub(r"[^a-z0-9]+", "-", post["title"].lower()).strip("-")[:60]
    path = POSTS_DIR / f"{datetime.date.today()}-{slug}.md"
    path.write_text(f"# {post['title']}\n\n_{post['subtitle']}_\n\n{post['body']}\n")
    return path


# ---------- substack ----------

def substack_api():
    from substack import Api

    pub = env("SUBSTACK_PUBLICATION_URL", required=True)
    cookies = env("SUBSTACK_COOKIES")
    if cookies:  # JSON exported via Api.export_cookies(), stored as a secret
        # Session cookies are a login credential: keep them out of the working tree so a
        # workflow that commits the run's output can never pick them up.
        fd, path = tempfile.mkstemp(suffix=".json")
        try:
            with os.fdopen(fd, "w") as f:
                f.write(cookies)
            return Api(cookies_path=path, publication_url=pub)
        finally:
            os.unlink(path)
    return Api(
        email=env("SUBSTACK_EMAIL", required=True),
        password=env("SUBSTACK_PASSWORD", required=True),
        publication_url=pub,
    )


def push_to_substack(post):
    from substack.post import Post

    api = substack_api()
    p = Post(title=post["title"], subtitle=post["subtitle"], user_id=api.get_user_id())
    p.from_markdown(post["body"], api=api)
    draft = api.post_draft(p.get_draft())
    draft_id = draft.get("id")
    if not draft_id:
        sys.exit(f"Substack did not return a draft id: {draft}")

    if MODE == "publish":
        api.prepublish_draft(draft_id)
        api.publish_draft(draft_id, send=SEND_EMAIL)
    return draft_id


# ---------- main ----------

def main():
    topics = read_topics()
    topic = topics[0] if topics else None
    print(f"Mode: {MODE} | Topic: {topic or '(Claude picks)'}")

    post = generate_post(topic)
    md_path = save_markdown(post)
    print(f"Generated: {post['title']} -> {md_path.name}")

    draft_id = None
    if MODE in ("draft", "publish"):
        draft_id = push_to_substack(post)
        print(f"Substack {'published' if MODE == 'publish' else 'draft created'}: id={draft_id}")

    if topic:
        remove_topic(topic)
    with LOG_FILE.open("a") as f:
        f.write(json.dumps({
            "date": str(datetime.date.today()),
            "title": post["title"],
            "topic": topic,
            "mode": MODE,
            "draft_id": draft_id,
            "file": md_path.name,
        }) + "\n")


if __name__ == "__main__":
    main()
