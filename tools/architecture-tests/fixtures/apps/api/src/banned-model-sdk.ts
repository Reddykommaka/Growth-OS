// VIOLATION: model provider SDKs may appear ONLY under packages/integrations/*
// (ADR-0013, 01-overview.md §3 principle 13).
import Anthropic from '@anthropic-ai/sdk';
export const client = Anthropic;
