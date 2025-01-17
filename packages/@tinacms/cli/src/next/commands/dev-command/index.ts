import { Command, Option } from 'clipanion'
import fs from 'fs-extra'
import path from 'path'
import chokidar from 'chokidar'
import { buildSchema, getASTSchema, Database } from '@tinacms/graphql'
import { ConfigManager } from '../../config-manager'
import { devHTML } from './html'
import { logger, summary } from '../../../logger'
import { createDevServer } from './server'
import { Codegen } from '../../codegen'
import chalk from 'chalk'
import { startSubprocess2 } from '../../../utils/start-subprocess'
import { createAndInitializeDatabase, createDBServer } from '../../database'
import type { ChildProcess } from 'child_process'

export class DevCommand extends Command {
  static paths = [['dev'], ['server:start']]
  port = Option.String('-p,--port', '4001', {
    description: 'Specify a port to run the server on. (default 4001)',
  })
  subCommand = Option.String('-c,--command', {
    description: 'The sub-command to run',
  })
  rootPath = Option.String('--rootPath', {
    description:
      'Specify the root directory to run the CLI from (defaults to current working directory)',
  })
  watchFolders = Option.String('-w,--watchFolders', {
    description:
      'a list of folders (relative to where this is being run) that the cli will watch for changes',
  })
  verbose = Option.Boolean('-v,--verbose', false, {
    description: 'increase verbosity of logged output',
  })
  noWatch = Option.Boolean('--noWatch', false, {
    description: "Don't regenerate config on file changes",
  })
  noSDK = Option.Boolean('--noSDK', false, {
    description: "Don't generate the generated client SDK",
  })
  noTelemetry = Option.Boolean('--noTelemetry', false, {
    description: 'Disable anonymous telemetry that is collected',
  })

  static usage = Command.Usage({
    category: `Commands`,
    description: `Builds Tina and starts the dev server`,
    examples: [
      [`A basic example`, `$0 dev`],
      [`A second example`, `$0 dev --rootPath`],
    ],
  })

  async catch(error: any): Promise<void> {
    logger.error('Error occured during tinacms dev')
    console.error(error)
    process.exit(1)
  }

  async execute(): Promise<number | void> {
    if (this.watchFolders) {
      logger.warn(
        '--watchFolders has been deprecated, if you still need it please open a ticket at https://github.com/tinacms/tinacms/issues'
      )
    }
    const configManager = new ConfigManager(this.rootPath)
    logger.info('Starting Tina Dev Server')

    // Initialize the host TCP server
    createDBServer()

    const setup = async () => {
      try {
        await configManager.processConfig()
      } catch (e) {
        logger.error(
          'Unable to start dev server, please fix your Tina config and try again'
        )
        logger.error(e.message)
        if (this.verbose) {
          console.error(e)
        }
        process.exit(1)
      }

      const database = await createAndInitializeDatabase(configManager)
      const { tinaSchema, graphQLSchema, queryDoc, fragDoc } =
        await buildSchema(database, configManager.config)
      if (!configManager.isUsingLegacyFolder) {
        delete require.cache[configManager.generatedSchemaJSONPath]
        delete require.cache[configManager.generatedLookupJSONPath]
        delete require.cache[configManager.generatedGraphQLJSONPath]

        const schemaObject = require(configManager.generatedSchemaJSONPath)
        const lookupObject = require(configManager.generatedLookupJSONPath)
        const graphqlSchemaObject = require(configManager.generatedGraphQLJSONPath)
        await fs.writeFileSync(
          path.join(configManager.tinaFolderPath, 'tina-lock.json'),
          JSON.stringify({
            schema: schemaObject,
            lookup: lookupObject,
            graphql: graphqlSchemaObject,
          })
        )
      }

      const codegen = new Codegen({
        schema: await getASTSchema(database),
        configManager: configManager,
        port: Number(this.port),
        noSDK: this.noSDK,
        queryDoc,
        fragDoc,
      })
      const apiURL = await codegen.execute()

      if (!this.noWatch) {
        this.watchQueries(configManager, async () => await codegen.execute())
      }

      await database.indexContent({ tinaSchema, graphQLSchema })
      return { apiURL, database }
    }
    const { apiURL, database } = await setup()

    await fs.outputFile(configManager.outputHTMLFilePath, devHTML(this.port))
    // Add the gitignore so the index.html and assets are committed to git
    await fs.outputFile(
      configManager.outputGitignorePath,
      'index.html\nassets/'
    )
    const server = await createDevServer(
      configManager,
      database,
      apiURL,
      this.noSDK,
      this.noWatch
    )
    await server.listen(Number(this.port))

    if (!this.noWatch) {
      this.watchContentFiles(configManager, database)
    }

    server.watcher.on('change', async (changedPath) => {
      if (changedPath.includes('__generated__')) {
        return
      }
      if (changedPath.includes('@tinacms/app')) {
        return
      }
      if (changedPath.includes('tinacms/dist')) {
        return
      }
      try {
        await setup()
        logger.info('Tina config updated')
      } catch (e) {
        logger.error(e.message)
      }
    })

    const subItems = []

    if (configManager.hasSeparateContentRoot()) {
      subItems.push({
        key: 'Content repo',
        value: configManager.contentRootPath,
      })
    }

    const summaryItems = [
      {
        emoji: '🦙',
        heading: 'Tina Config',
        subItems: [
          {
            key: 'CMS',
            value: `<your-dev-server-url>/${configManager.printoutputHTMLFilePath()}`,
          },
          {
            key: 'API playground',
            value: `<your-dev-server-url>/${configManager.printoutputHTMLFilePath()}#/graphql`,
          },
          {
            key: 'API url',
            value: apiURL,
          },
          ...subItems,
        ],
      },
    ]

    if (!this.noSDK) {
      summaryItems.push({
        emoji: '🤖',
        heading: 'Auto-generated files',
        subItems: [
          {
            key: 'GraphQL Client',
            value: configManager.printGeneratedClientFilePath(),
          },
          {
            key: 'Typescript Types',
            value: configManager.printGeneratedTypesFilePath(),
          },
        ],
      })
    }

    summary({
      heading: 'Tina Dev Server is running...',
      items: [
        ...summaryItems,
        // {
        //   emoji: '📚',
        //   heading: 'Useful links',
        //   subItems: [
        //     {
        //       key: 'Custom queries',
        //       value: 'https://tina.io/querying',
        //     },
        //     {
        //       key: 'Visual editing',
        //       value: 'https://tina.io/visual-editing',
        //     },
        //   ],
        // },
      ],
    })
    let subProc: ChildProcess | undefined
    if (this.subCommand) {
      subProc = await startSubprocess2({ command: this.subCommand })
      logger.info(`Starting subprocess: ${chalk.cyan(this.subCommand)}`)
    }
    function exitHandler(options, exitCode) {
      if (subProc) {
        subProc.kill()
      }
      process.exit()
    }
    //do something when app is closing
    process.on('exit', exitHandler)
    //catches ctrl+c event
    process.on('SIGINT', exitHandler)
    // catches "kill pid" (for example: nodemon restart)
    process.on('SIGUSR1', exitHandler)
    process.on('SIGUSR2', exitHandler)
    //catches uncaught exceptions
    process.on('uncaughtException', exitHandler)
  }

  watchContentFiles(configManager: ConfigManager, database: Database) {
    const collectionContentFiles = []
    configManager.config.schema.collections.forEach((collection) => {
      const collectionGlob = `${path.join(
        configManager.contentRootPath,
        collection.path
      )}/**/*.${collection.format || 'md'}`
      collectionContentFiles.push(collectionGlob)
    })
    let ready = false
    /**
     * This has no way of knowing whether the change to the file came from someone manually
     * editing in their IDE or Tina pushing the update via the Filesystem bridge. It's a simple
     * enough update that it's fine that when Tina pushes a change, we go and push that same
     * thing back through the database, and Tina Cloud does the same thing when it receives
     * a push from Github.
     */
    chokidar
      .watch(collectionContentFiles)
      .on('ready', () => {
        ready = true
      })
      .on('add', async (addedFile) => {
        if (!ready) {
          return
        }
        const pathFromRoot = configManager.printContentRelativePath(addedFile)
        database.indexContentByPaths([pathFromRoot])
      })
      .on('change', async (changedFile) => {
        const pathFromRoot = configManager.printContentRelativePath(changedFile)
        // Optionally we can reload the page when this happens
        // server.ws.send({ type: 'full-reload', path: '*' })
        database.indexContentByPaths([pathFromRoot])
      })
      .on('unlink', async (removedFile) => {
        const pathFromRoot = configManager.printContentRelativePath(removedFile)
        database.deleteContentByPaths([pathFromRoot])
      })
  }
  watchQueries(configManager: ConfigManager, callback: () => Promise<string>) {
    let ready = false
    /**
     * This has no way of knowing whether the change to the file came from someone manually
     * editing in their IDE or Tina pushing the update via the Filesystem bridge. It's a simple
     * enough update that it's fine that when Tina pushes a change, we go and push that same
     * thing back through the database, and Tina Cloud does the same thing when it receives
     * a push from Github.
     */
    chokidar
      .watch(configManager.userQueriesAndFragmentsGlob)
      .on('ready', () => {
        ready = true
      })
      .on('add', async (addedFile) => {
        await callback()
      })
      .on('change', async (changedFile) => {
        await callback()
      })
      .on('unlink', async (removedFile) => {
        await callback()
      })
  }
}
