import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import type { TestProject } from 'vitest/node'

declare module 'vitest' {
  export interface ProvidedContext {
    pgUrl: string
  }
}

let container: StartedPostgreSqlContainer | undefined

export async function setup(project: TestProject) {
  // CHAT_TEST_DATABASE_URL points at an existing server (a superuser that may CREATE DATABASE) instead of Docker.
  const url = process.env.CHAT_TEST_DATABASE_URL ?? (container = await new PostgreSqlContainer('postgres:18-alpine').start()).getConnectionUri()
  project.provide('pgUrl', url)
}

export async function teardown() {
  await container?.stop()
}
