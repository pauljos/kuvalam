import { executeCustomSkill } from './src/services/skill-executor.service.js'

async function test() {
  const code = `
    const res = await fetch('https://jsonplaceholder.typicode.com/todos/1');
    const data = await res.json();
    return {
      message: "Hello from sandbox!",
      inputReceived: input.name,
      secretUsed: env.SECRET_KEY,
      fetchedTitle: data.title
    };
  `

  try {
    const result = await executeCustomSkill(code, { name: 'Kuvalam' }, { SECRET_KEY: '12345' })
    console.log("Skill execution successful:")
    console.log(result)
  } catch (err) {
    console.error("Skill execution failed:", err)
  }
}

test()
