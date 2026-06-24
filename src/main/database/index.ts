import { initDb } from './init'
import { applySchema } from './schema'
import { runMigrations } from './migrations'
import * as users from './repositories/userRepo'
import * as conversations from './repositories/conversationRepo'
import * as messages from './repositories/messageRepo'
import * as settings from './repositories/settingsRepo'
import * as subscriptions from './repositories/subscriptionRepo'

export function initDatabase(): void {
  initDb()
  applySchema()
  runMigrations()
}

export const database = {
  users,
  conversations,
  messages,
  settings,
  subscriptions
}

export type { UserRow, UserData } from './repositories/userRepo'
export type { ConversationRow } from './repositories/conversationRepo'
export type { MessageRow } from './repositories/messageRepo'
export type { SubscriptionRow } from './repositories/subscriptionRepo'
