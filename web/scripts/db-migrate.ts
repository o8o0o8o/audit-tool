import { runMigrations } from '../db/migrate';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set (copy web/.env.local.example to web/.env.local)');
  process.exit(1);
}
runMigrations(url).then(
  () => console.log('migrations applied'),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
