import fs from 'fs-extra'
import { GraphQLSchema, printSchema } from 'graphql'
import { generateTypes } from './codegen'
import { transform } from 'esbuild'
import { ConfigManager } from '../config-manager'
export const TINA_HOST = 'content.tinajs.io'

export class Codegen {
  configManager: ConfigManager
  port?: number
  schema: GraphQLSchema
  queryDoc: string
  fragDoc: string
  noSDK: boolean

  constructor({
    configManager,
    port,
    schema,
    noSDK,
    queryDoc,
    fragDoc,
  }: {
    configManager: ConfigManager
    port?: number
    schema: GraphQLSchema
    noSDK: boolean
    queryDoc: string
    fragDoc: string
  }) {
    this.configManager = configManager
    this.port = port
    this.schema = schema
    this.noSDK = noSDK
    this.queryDoc = queryDoc
    this.fragDoc = fragDoc
  }

  async removeGeneratedFilesIfExists() {
    await unlinkIfExists(this.configManager.generatedClientJSFilePath)
    await unlinkIfExists(this.configManager.generatedTypesDFilePath)
    await unlinkIfExists(this.configManager.generatedTypesJSFilePath)
    await unlinkIfExists(this.configManager.generatedTypesTSFilePath)
    await unlinkIfExists(this.configManager.generatedClientTSFilePath)
    await unlinkIfExists(this.configManager.generatedQueriesFilePath)
    await unlinkIfExists(this.configManager.generatedFragmentsFilePath)
  }

  async execute() {
    const apiURL = this.getApiURL()
    if (this.noSDK) {
      await this.removeGeneratedFilesIfExists()
      return apiURL
    }
    await fs.outputFile(
      this.configManager.generatedQueriesFilePath,
      this.queryDoc
    )
    await fs.outputFile(
      this.configManager.generatedFragmentsFilePath,
      this.fragDoc
    )
    await maybeWarnFragmentSize(this.configManager.generatedFragmentsFilePath)

    const { clientString } = await this.genClient()
    const { codeString, schemaString } = await this.genTypes()

    await fs.outputFile(
      this.configManager.generatedGraphQLGQLPath,
      schemaString
    )
    if (this.configManager.isUsingTs()) {
      await fs.outputFile(
        this.configManager.generatedTypesTSFilePath,
        codeString
      )
      await fs.outputFile(
        this.configManager.generatedClientTSFilePath,
        clientString
      )
      await unlinkIfExists(this.configManager.generatedClientJSFilePath)
      await unlinkIfExists(this.configManager.generatedTypesDFilePath)
      await unlinkIfExists(this.configManager.generatedTypesJSFilePath)
    } else {
      await fs.outputFile(
        this.configManager.generatedTypesDFilePath,
        codeString
      )
      const jsCode = await transform(codeString, { loader: 'ts' })
      await fs.outputFile(
        this.configManager.generatedTypesJSFilePath,
        jsCode.code
      )
      await fs.outputFile(
        this.configManager.generatedClientJSFilePath,
        clientString
      )
      await unlinkIfExists(this.configManager.generatedTypesTSFilePath)
      await unlinkIfExists(this.configManager.generatedClientTSFilePath)
    }
    return apiURL
  }

  getApiURL() {
    const branch = this.configManager.config?.branch
    const clientId = this.configManager.config?.clientId
    const token = this.configManager.config?.token
    const version = this.configManager.getTinaGraphQLVersion()
    const baseUrl =
      this.configManager.config.tinaioConfig?.contentApiUrlOverride ||
      `https://${TINA_HOST}`

    if (
      (!branch || !clientId || !token) &&
      !this.port &&
      !this.configManager.config.contentApiUrlOverride
    ) {
      const missing = []
      if (!branch) missing.push('branch')
      if (!clientId) missing.push('clientId')
      if (!token) missing.push('token')

      throw new Error(
        `Client not configured properly. Missing ${missing.join(
          ', '
        )}. Please visit https://tina.io/docs/tina-cloud/connecting-site/ for more information`
      )
    }

    let apiURL = this.port
      ? `http://localhost:${this.port}/graphql`
      : `${baseUrl}/${version}/content/${clientId}/github/${branch}`

    if (this.configManager.config.contentApiUrlOverride) {
      apiURL = this.configManager.config.contentApiUrlOverride
    }
    return apiURL
  }

  async genClient() {
    const token = this.configManager.config?.token
    const apiURL = this.getApiURL()

    const clientString = `import { createClient } from "tinacms/dist/client";
import { queries } from "./types";
export const client = createClient({ url: '${apiURL}', token: '${token}', queries });
export default client;
  `
    return { apiURL, clientString }
  }

  async genTypes() {
    const typescriptTypes = await generateTypes(
      this.schema,
      this.configManager.userQueriesAndFragmentsGlob,
      this.configManager.generatedQueriesAndFragmentsGlob,
      this.getApiURL()
    )
    const codeString = `//@ts-nocheck
  // DO NOT MODIFY THIS FILE. This file is automatically generated by Tina
  export function gql(strings: TemplateStringsArray, ...args: string[]): string {
    let str = ''
    strings.forEach((string, i) => {
      str += string + (args[i] || '')
    })
    return str
  }
  ${typescriptTypes}
  `

    const schemaString = `# DO NOT MODIFY THIS FILE. This file is automatically generated by Tina
${await printSchema(this.schema)}
schema {
  query: Query
  mutation: Mutation
}
`
    return { codeString, schemaString }
  }
}

const maybeWarnFragmentSize = async (filepath: string) => {
  if (
    // is the file bigger then 100kb?
    (await (await fs.stat(filepath)).size) >
    // convert to 100 kb to bytes
    100 * 1024
  ) {
    console.warn(
      'Warning: frags.gql is very large (>100kb). Consider setting the reference depth to 1 or 0. See code snippet below.'
    )
    console.log(
      `const schema = defineSchema({
        config: {
            client: {
                referenceDepth: 1,
            },
        }
        // ...
    })`
    )
  }
}

const unlinkIfExists = async (filepath: string) => {
  if (await fs.existsSync(filepath)) {
    await fs.unlinkSync(filepath)
  }
}