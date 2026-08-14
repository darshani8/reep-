import { Module } from '@nestjs/common';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SsoController } from './sso.controller';

@Module({
  controllers: [AuthController, SsoController],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
