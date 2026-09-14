import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './http/app.module';

// Deliberately no global ValidationPipe here: it depends on
// emitDecoratorMetadata being faithfully reproduced by the transpiler,
// which `tsx`/esbuild does not reliably do for method-parameter types -
// see src/http/validate-dto.ts, which every controller uses instead.
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`API listening on port ${port}`);
}

bootstrap();
