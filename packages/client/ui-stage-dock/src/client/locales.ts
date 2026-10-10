/** `stageDock` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'stageDock'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'toggle.label': '舞台',
  'toggle.open': '打开舞台面板',
  'toggle.close': '关闭舞台面板',
  'panel.aria': '舞台面板',
  'panel.title': '舞台',
  'panel.bound': '会话 {id}',
  'panel.unbound': '未绑定',
  'field.aria': 'Forage 会话 ID',
  'field.placeholder': '会话 ID',
  'attach': '绑定',
  'empty': '输入 Forage 会话 ID 并绑定，舞台即在此显示。',
  'frame.title': '舞台 {id}',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<StageDockKey, string> = {
  'toggle.label': 'Stage',
  'toggle.open': 'Open the stage panel',
  'toggle.close': 'Close the stage panel',
  'panel.aria': 'Stage panel',
  'panel.title': 'Stage',
  'panel.bound': 'Conversation {id}',
  'panel.unbound': 'Not attached',
  'field.aria': 'Forage conversation id',
  'field.placeholder': 'Conversation id',
  'attach': 'Attach',
  'empty': 'Enter a Forage conversation id and attach; the stage appears here.',
  'frame.title': 'Stage {id}',
}

/** Key domain of the `stageDock` namespace (zh is the source of truth). */
export type StageDockKey = keyof typeof zh
