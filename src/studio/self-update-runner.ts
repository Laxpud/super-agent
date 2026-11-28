import { isAbsolute } from 'node:path'
import { runStudioUpdateController } from './self-update-controller.ts'

// 入口只接受宿主写入的私有交接文件，既不从 argv 接收凭据，也不启动交互 Shell。
const plan = process.argv[2]
if (process.argv.length !== 3 || !plan || !isAbsolute(plan)) process.exitCode = 1
else await runStudioUpdateController(plan).catch(() => { process.exitCode = 1 })
