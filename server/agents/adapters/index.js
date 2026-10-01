import { registerAdapter } from '../adapter.js'
import { ClaudeAdapter } from './claude.js'
import { CodexAdapter } from './codex.js'
import { DevinAdapter } from './devin.js'
import { GeminiAdapter } from './gemini.js'
import { QwenAdapter } from './qwen.js'
import { OpenCodeAdapter } from './opencode.js'
import { GrokAdapter } from './grok.js'
import { HarpyAdapter } from './harpy.js'

export function registerAllAdapters() {
  for (const AdapterClass of [HarpyAdapter, ClaudeAdapter, CodexAdapter, DevinAdapter, GeminiAdapter, QwenAdapter, OpenCodeAdapter, GrokAdapter]) {
    registerAdapter(AdapterClass)
  }
}
