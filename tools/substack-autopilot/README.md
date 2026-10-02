# Substack Autopilot

Picks a topic, writes a post with Claude, and creates a Substack draft (or publishes it).

This is a standalone Python tool. It sits outside the TypeScript workspace and is not part
of the Growth OS platform: it calls the Anthropic SDK directly rather than through
`packages/integrations/*` ([ADR-0013](../../docs/adr/0013-model-provider-abstraction.md)).

## Run it locally

```bash
cd tools/substack-autopilot
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
ANTHROPIC_API_KEY=... PUBLISH_MODE=dry python autopilot.py
```

`dry` only writes Markdown to `posts/`. Check a few of those before using `draft`.

## Modes (`PUBLISH_MODE`)

| Mode | What happens |
| --- | --- |
| `dry` | Generate and save to `posts/`. Substack is not touched. |
| `draft` (default) | Also create a Substack draft for you to review and publish. |
| `publish` | Create and publish right away. Emails subscribers only if `SEND_EMAIL=true`. |

## Configuration

| Variable | Required | Default |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | — |
| `SUBSTACK_PUBLICATION_URL` | `draft` / `publish` | — |
| `SUBSTACK_COOKIES` | one of cookies or email + password | — |
| `SUBSTACK_EMAIL`, `SUBSTACK_PASSWORD` | see above | — |
| `CLAUDE_MODEL` | no | `claude-sonnet-5-5` |
| `BLOG_NICHE`, `BLOG_AUDIENCE`, `BLOG_VOICE` | no | see `autopilot.py` |
| `WORD_COUNT` | no | `900` |
| `SEND_EMAIL` | no | `false` |

Prefer `SUBSTACK_COOKIES` over email and password: Substack often blocks password logins
from cloud runners with a captcha. Export the cookies once from your own machine:

```python
from substack import Api
Api(email="you@example.com", password="...", publication_url="https://you.substack.com") \
    .export_cookies("cookies.json")
```

Paste the file's contents into the secret, then delete the file. The script writes the
cookies to a temporary file outside the repository and removes it once it has logged in.

## Files

- `topics.txt` — queue of topics, one per line. Each run uses the first one and removes it.
- `posts/` — the Markdown of every generated post.
- `published.jsonl` — one line per run. Recent titles are fed back to Claude so it doesn't
  repeat itself.

## Scheduled runs

`.github/workflows/substack-autopilot.yml` runs the script and commits `topics.txt`,
`posts/` and `published.jsonl` back to the branch. It only runs when started by hand, so
nothing happens until you've added the secrets and are happy with the output. To run it
daily, uncomment the `schedule` block in that workflow.

Add these as repository secrets: `ANTHROPIC_API_KEY`, `SUBSTACK_PUBLICATION_URL` and
`SUBSTACK_COOKIES`. This repository is public, so `posts/` and `published.jsonl` will be
public too.
