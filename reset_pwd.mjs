import bcrypt from 'bcryptjs';
import pg from 'pg';

async function run() {
  const hash = await bcrypt.hash('password123', 12);
  const client = new pg.Client({ connectionString: 'postgresql://axon:axon_dev_password@localhost:5434/axon_db' });
  await client.connect();
  await client.query(`UPDATE users SET password_hash = $1 WHERE email = 'paul@acme.com'`, [hash]);
  await client.end();
  console.log("Password updated to password123 for paul@acme.com");
}
run().catch(console.error);
