process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET ||= 'test_secret_used_only_in_tests_0000000000';
process.env.DATABASE_URL ||= 'postgres://taskmanager:taskmanager@localhost:5433/taskmanager';
process.env.LOG_LEVEL ||= 'silent';
