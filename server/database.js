'use strict';

const { Pool } = require('pg');
const { sql } = require('drizzle-orm');
const { drizzle } = require('drizzle-orm/node-postgres');
const { pgTable, text, uuid, jsonb, timestamp } = require('drizzle-orm/pg-core');

const classroomRooms = pgTable('classroom_rooms', {
  code: text('code').primaryKey(),
  ownerId: uuid('owner_id'),
  memberIds: uuid('member_ids').array().notNull().default(sql`'{}'::uuid[]`),
  state: jsonb('state').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull()
});

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const db = drizzle(pool, { schema: { classroomRooms } });

module.exports = { db, pool, classroomRooms };
