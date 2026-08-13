import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { StudentModule } from './student/student.module';
import { JobsModule } from './jobs/jobs.module';

@Module({
  imports: [
    // Loads apps/api/.env — the shared DATABASE_URL and AUTH_SECRET — before any
    // provider (including PrismaService) is constructed, so process.env is
    // populated when the client reads it. Global so no feature re-imports it.
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    StudentModule,
    JobsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
