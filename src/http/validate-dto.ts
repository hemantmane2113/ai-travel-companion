import { BadRequestException } from '@nestjs/common';
import { plainToInstance, type ClassConstructor } from 'class-transformer';
import { validate } from 'class-validator';

/**
 * Explicit DTO validation, deliberately NOT relying on NestJS's
 * automatic ValidationPipe metatype inference. That inference depends
 * on TypeScript's emitDecoratorMetadata being faithfully reproduced by
 * whatever transpiles this code - and `tsx` (used for both `npm run
 * start:api` and, via Vitest, the test suite) transpiles via esbuild,
 * which does not reliably emit method-parameter type metadata. Relying
 * on the automatic pipe here would silently skip validation in
 * production, not just in tests - this was caught by the e2e test
 * (`test/http/app.e2e.test.ts`), not assumed to work.
 */
export async function validateDto<T extends object>(
  cls: ClassConstructor<T>,
  body: unknown,
): Promise<T> {
  const instance = plainToInstance(cls, body);
  const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
  if (errors.length > 0) {
    const messages = errors.flatMap((e) => Object.values(e.constraints ?? {}));
    throw new BadRequestException(messages);
  }
  return instance;
}
