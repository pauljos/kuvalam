import pg from 'pg'

const urls = [
  'postgresql://dbuser1:postgres@localhost:5432/control_framework_db',
  'postgresql://dbuser1:postgres@localhost:5434/control_framework_db',
  'postgresql://dbuser1:postgres@127.0.0.1:5432/control_framework_db',
  'postgresql://dbuser1:postgres@127.0.0.1:5434/control_framework_db'
]

async function test() {
  for (const url of urls) {
    console.log(`Testing ${url}...`)
    const client = new pg.Client(url)
    try {
      await client.connect()
      console.log(`CONNECTED SUCCESSFULLY to ${url}!`)
      const res = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)
      console.log('Tables found:', res.rows.map(r => r.table_name))
      await client.end()
      return
    } catch (e) {
      console.log(`Failed: ${e.message}`)
    }
  }
}
test()
