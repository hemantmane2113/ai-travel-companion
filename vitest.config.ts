import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    hookTimeout: 30000,
    testTimeout: 30000,
    // reflect-metadata must load before any Nest-decorated class
    // (controllers, DTOs) is first imported by a test file.
    setupFiles: ['dotenv/config', 'reflect-metadata'],
  },
});
