import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';

import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Reads the http-only session cookie back off the request.
  app.use(cookieParser());

  // Every route lives under /api, matching the Angular client's apiBase and the
  // dev proxy, so the browser sees a same-origin call and the cookie flows.
  app.setGlobalPrefix('api');

  // The Angular dev server is a different origin (4200 vs 3200); credentials
  // must be allowed explicitly or the session cookie is dropped. In production
  // the two are served same-origin and this is a no-op.
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:4200',
    credentials: true,
  });

  await app.listen(process.env.PORT ?? 3200);
}
void bootstrap();
