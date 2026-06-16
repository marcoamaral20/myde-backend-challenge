process.env.NODE_ENV ??= "test";
process.env.LOG_LEVEL ??= "silent";
process.env.DATABASE_URL ??=
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@localhost:5432/myde_test";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.META_VERIFY_TOKEN ??= "test-verify-token";
process.env.META_APP_SECRET ??= "test-app-secret";
process.env.META_API_BASE_URL ??= "http://localhost:8001";
process.env.AI_PROVIDER ??= "stub";
