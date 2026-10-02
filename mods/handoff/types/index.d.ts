export type Files = string[]

declare module 'claude-code' {
  interface PluginState {
    handoff: {
      files: Files
    }
  }
}
