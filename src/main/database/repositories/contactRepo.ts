import { getDb } from '../init'
import { randomUUID } from 'crypto'

/**
 * contacts / contact_identities — the persistence tier for contact identity.
 *
 * One `contacts` row is one real person. Each `contact_identities` row is one
 * handle that person is reachable at on one channel: a WhatsApp chat name, a
 * Telegram numeric chat_id, a Slack user/channel id, a Gmail address. That is
 * what lets "is there anything from him" span channels — the question names a
 * person, and the person owns handles on four surfaces whose identifiers look
 * nothing alike.
 *
 * Deliberately plain, and deliberately NOT merged into channel_memory: memory
 * rows are an append-only log of things that happened, while identity is
 * long-lived state the user curates. Keeping them apart means clearing memory
 * does not un-teach the app who "him" is.
 *
 * Everything stays in the local SQLite DB. No row is ever uploaded.
 */
export interface ContactRow {
  id: string
  /** Display form, as the user would say it ("Ashu"). */
  display_name: string
  /** Normalised lookup key for the display name. */
  name_key: string
  created_at: number
}

export interface ContactIdentityRow {
  id: string
  contact_id: string
  /** whatsapp | telegram | slack | gmail */
  channel: string
  /** The handle exactly as the channel's own tools take it. */
  handle: string
  /** Normalised lookup key for the handle. */
  handle_key: string
  /**
   * 'user'  — the user explicitly said this handle is this person.
   * 'auto'  — derived from a display name the channel itself exposed.
   * The distinction is surfaced in list_contacts so a guessed-looking link is
   * visible to the user rather than indistinguishable from one they made.
   */
  source: string
  created_at: number
}

/** A person plus every handle they are reachable at. */
export interface ContactWithIdentities {
  contact: ContactRow
  identities: ContactIdentityRow[]
}

/** Find a contact by its normalised name key. */
export function findContactByNameKey(nameKey: string): ContactRow | undefined {
  return getDb().prepare('SELECT * FROM contacts WHERE name_key = ?').get(nameKey) as
    | ContactRow
    | undefined
}

/** Find a contact by id. */
export function findContactById(id: string): ContactRow | undefined {
  return getDb().prepare('SELECT * FROM contacts WHERE id = ?').get(id) as ContactRow | undefined
}

/**
 * Insert a contact, or return the existing one with this name key.
 *
 * The display name of an existing contact is left alone: the user named them
 * once, and silently rewriting "Ashu" to "ashu" because a later call passed a
 * differently-cased string would churn every label already shown in the UI.
 */
export function upsertContact(displayName: string, nameKey: string): ContactRow {
  const existing = findContactByNameKey(nameKey)
  if (existing) return existing
  const id = randomUUID()
  getDb()
    .prepare('INSERT INTO contacts (id, display_name, name_key) VALUES (?, ?, ?)')
    .run(id, displayName, nameKey)
  return findContactById(id) as ContactRow
}

/** The identity registered for `handleKey` on `channel`, if any. */
export function findIdentity(channel: string, handleKey: string): ContactIdentityRow | undefined {
  return getDb()
    .prepare('SELECT * FROM contact_identities WHERE channel = ? AND handle_key = ?')
    .get(channel, handleKey) as ContactIdentityRow | undefined
}

/** Every handle registered for one contact, oldest first. */
export function identitiesForContact(contactId: string): ContactIdentityRow[] {
  return getDb()
    .prepare(
      'SELECT * FROM contact_identities WHERE contact_id = ? ORDER BY created_at ASC, rowid ASC'
    )
    .all(contactId) as ContactIdentityRow[]
}

/**
 * Register a handle against a contact, replacing whoever held it before.
 *
 * Replacement rather than rejection is the right behaviour for a correction:
 * the user linked a Telegram id to the wrong person and is now fixing it. The
 * UNIQUE(channel, handle_key) constraint means the old row must go for the new
 * one to exist, so this is a move, never a fork that leaves two owners.
 */
export function putIdentity(input: {
  contactId: string
  channel: string
  handle: string
  handleKey: string
  source: string
}): ContactIdentityRow {
  const db = getDb()
  db.prepare('DELETE FROM contact_identities WHERE channel = ? AND handle_key = ?').run(
    input.channel,
    input.handleKey
  )
  const id = randomUUID()
  db.prepare(
    `INSERT INTO contact_identities (id, contact_id, channel, handle, handle_key, source)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, input.contactId, input.channel, input.handle, input.handleKey, input.source)
  return db.prepare('SELECT * FROM contact_identities WHERE id = ?').get(id) as ContactIdentityRow
}

/** Remove one handle. Returns true when a row was actually removed. */
export function deleteIdentity(channel: string, handleKey: string): boolean {
  const info = getDb()
    .prepare('DELETE FROM contact_identities WHERE channel = ? AND handle_key = ?')
    .run(channel, handleKey)
  return Number(info.changes) > 0
}

/** Every contact with its handles, alphabetical by display name. */
export function listContacts(): ContactWithIdentities[] {
  const contacts = getDb()
    .prepare('SELECT * FROM contacts ORDER BY display_name COLLATE NOCASE ASC')
    .all() as ContactRow[]
  return contacts.map((contact) => ({
    contact,
    identities: identitiesForContact(contact.id)
  }))
}

/**
 * Delete a contact and (via ON DELETE CASCADE) its handles. Returns true when a
 * row was removed.
 *
 * The identities are also deleted explicitly because SQLite only enforces
 * foreign keys when `PRAGMA foreign_keys = ON`, which is not guaranteed on
 * every connection this repository runs against. Leaving orphaned identity rows
 * behind would keep resolving a handle to a person who no longer exists.
 */
export function deleteContact(id: string): boolean {
  const db = getDb()
  db.prepare('DELETE FROM contact_identities WHERE contact_id = ?').run(id)
  const info = db.prepare('DELETE FROM contacts WHERE id = ?').run(id)
  return Number(info.changes) > 0
}

/** Diagnostics / tests. */
export function countContacts(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM contacts').get() as { n: number }
  return row.n
}
