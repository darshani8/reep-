/**
 * The one Prisma client for the API.
 *
 * It resolves `@prisma/client` to the client generated from the repo's single
 * `prisma/schema.prisma` (up in the root node_modules) — the same schema and
 * the same database the Next.js app reads during the migration, so a session
 * minted here and a roster read there agree to the row.
 */

import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
