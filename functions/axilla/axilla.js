const fs = require('fs').promises
const path = require('path')
const util = require('util')
const fetch = require('node-fetch')
const execFile = util.promisify(require('child_process').execFile)

const RESERVERD_PARAMS = [
  'format',
  'output',
  'applet',
  'version'
]

const FORMATS = {
  WEBP: 'webp',
  GIF: 'gif',
}

const OUTPUTS = {
  HTML: 'html',
  IMAGE: 'image',
  BASE64: 'base64',
}

const CSS_CLASSES = {
  PIXETLATE: 'pixelate',
}

// environment variables
// these are dynamically generated using a plugin so destructuring cannot be used
/* eslint-disable prefer-destructuring */
const PIXLET_BINARY = process.env.PIXLET_BINARY
const PIXLET_BINARY_PATH = process.env.PIXLET_BINARY_PATH
const LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH
/* eslint-enable prefer-destructuring */

// static paths
const TMP_PATH = '/tmp/'
const ASSETS_PATH = path.join(__dirname, 'assets')
const DEFAULT_APPLET_PATH = path.join(ASSETS_PATH, 'default.star')
const INPUT_APPLET_PATH = path.join(TMP_PATH, 'input.star')
const HTML_TEMPLATE_PATH = path.join(ASSETS_PATH, 'basic.html')

// executes pixlet with the given arguments
const executePixlet = async (args) => {
  const command = PIXLET_BINARY_PATH ? path.join(PIXLET_BINARY_PATH, PIXLET_BINARY) : PIXLET_BINARY
  const opts = LD_LIBRARY_PATH ? { env: { LD_LIBRARY_PATH } } : undefined
  return execFile(command, args, opts)
}

// helper functions
const getOutputPath = (format) => path.join(TMP_PATH, `output.${format}`)
const getPixletVersion = async () => (await executePixlet(['version'])).stdout

exports.handler = async (event) => {
  // query params
  const params = event.queryStringParameters
  const appletUrl = params.applet
  const appletPath = appletUrl ? INPUT_APPLET_PATH : DEFAULT_APPLET_PATH
  const format = (params.format && FORMATS[params.format.toUpperCase()]) || FORMATS.WEBP
  const output = (params.output && OUTPUTS[params.output.toUpperCase()]) || OUTPUTS.HTML
  const cssClass = params.pixelate === 'false' ? '' : CSS_CLASSES.PIXETLATE
  const isVersionRequest = params.version === 'true'
  const isMongoRequest = params.mongo === 'true'
  const isDeviceConfigRequest = params.config === 'true'

  const { MongoClient } = require("mongodb");
  const mongoClient = new MongoClient(process.env.MONGODB_URI);
  const clientPromise = mongoClient.connect();

  // setup pixlet
  const outputPath = getOutputPath(format)
  const args = ['render', appletPath, `--output=${outputPath}`]
  if (format === FORMATS.GIF) {
    args.push('--gif=true')
  }

  // return the pixlet version when the `version` param is true
  if (isVersionRequest) {
    try {
      const pixletVersion = await getPixletVersion()
      return {
        statusCode: 200,
        headers: { 'content-type': 'text/plain' },
        body: pixletVersion,
      }
    } catch (error) {
      return {
        statusCode: 500,
        body: `Error: Could not get version info. ${error.message}`,
      }
    }
  }

  if (isMongoRequest) {
    try {
      const database = (await clientPromise).db(process.env.MONGODB_DATABASE);
      const collection = database.collection(process.env.MONGODB_COLLECTION);
      const results = await collection.find({}).limit(10).toArray();
      return {
        statusCode: 200,
        body: JSON.stringify(results),
      }
    } catch (error) {
      return { statusCode: 500, body: error.toString() }
    }
  }

  // pass non-reserved params to pixlet
  // don't allow params that begin with `-`
  Object.keys(params).forEach((key) => {
    if (!RESERVERD_PARAMS.includes(key) && key.charAt(0) !== '-') {
      args.push(`${key}=${params[key]}`)
    }
  })

  // download the applet if provided
  if (!!appletUrl) {
    try {
      const response = await fetch(appletUrl, {
        headers: { Accept: 'text/plain' },
        size: 10000000, // 10 MB
        timeout: 30000, // 30 seconds
      })
      if (!response.ok) {
        return {
          statusCode: response.status,
          body: `Error: Could not fetch applet. ${response.statusText}`
        }
      }
      const appletText = await response.text()
      await fs.writeFile(INPUT_APPLET_PATH, appletText)
    } catch (error) {
      return {
        statusCode: 500,
        body: `Error: Could not download applet. ${error.message}`
      }
    }
  }
  // run pixlet
  try {
    await executePixlet(args)
  } catch (error) {
    const appletMessage = !!appletUrl ? 'Ensure the provided applet is valid.' : ''
    return {
      statusCode: 500,
      body: `Error: Failed to generate image with Pixlet. ${appletMessage} ${error.message}`,
      error: error.message
    }
  }

  // base64 encode the generated image
  const imageBase64 = await fs.readFile(outputPath, 'base64', function (err, data) {
    if (err) {
      return {
        statusCode: 500,
        body: `Error: Could not read output file. ${error.message} ${outputPath}`
      }
    }
  });

  // delete the temp input and output files
  try { await fs.unlink(INPUT_APPLET_PATH) } catch (error) { /* noop */ }
  try { await fs.unlink(outputPath) } catch (error) { /* noop */ }

  // check base64 data
  if (!imageBase64) {
    return {
      statusCode: 500,
      body: 'Error: Could not read output image.'
    }
  }

  if (!isDeviceConfigRequest) {
    switch (output) {
      // raw image
      case OUTPUTS.IMAGE:
        return {
          statusCode: 200,
          headers: { 'content-type': `image/${format}` },
          body: imageBase64,
          isBase64Encoded: true
        }

      // base64 image text
      case OUTPUTS.BASE64:
        return {
          statusCode: 200,
          headers: { 'content-type': 'text/plain' },
          body: imageBase64
        }

      // html preview
      case OUTPUTS.HTML:
      default: {
        let html
        try {
          html = await fs.readFile(HTML_TEMPLATE_PATH, 'utf8')
          html = html.replace(/\{format\}|\{image\}|\{class\}/gi, (match) => {
            if (match === '{format}') return format
            if (match === '{image}') return imageBase64
            if (match === '{class}') return cssClass
            return match
          })
        } catch (error) {
          return {
            statusCode: 500,
            body: `Error: Could not generate html. ${error.message}`
          }
        }

        return {
          statusCode: 200,
          headers: { 'content-type': 'text/html' },
          body: html
        }
      }
    }
  }
  else{
    
    const formData = new FormData();
    var jsonObj;
    try {
      const database = (await clientPromise).db(process.env.MONGODB_DATABASE);
      const collection = database.collection(process.env.MONGODB_COLLECTION);
      const results = await collection.find({}).limit(10).toArray();
      //jsonObj = JSON.parse(results);
      formData.append('config', JSON.stringify(results));
    } catch (error) {
      return { statusCode: 500, body: error.toString() }
    }
    switch (output) {
      // raw image
      case OUTPUTS.IMAGE:
         // formData.append(format,imageBase64)
          jsonObj[`${format}`] = JSON.stringify(imageBase64);
          return{
            statusCode: 200,
            headers: {'content-type':'multipart/form-data'},
            //body: formData
            body: JSON.stringify(jsonObj)
          }

      // base64 image text
      case OUTPUTS.BASE64:
       // formData.append("base64",imageBase64);
          jsonObj[`base64`] = JSON.stringify(imageBase64);
        return{
          statusCode: 200,
          headers: {'content-type':'multipart/form-data'},
          //body: formData
          body: JSON.stringify(jsonObj)
        }

      default:
       formData.append("webp",imageBase64)
          //jsonObj[`webp`] = JSON.stringify(imageBase64);
          const response = new Response(formData);
          //response.status = 200;
          return  {
            statusCode: response.status,
            body: response.formData
          }
        // return{
        //   statusCode: 200,
        //   headers: {'content-type':'multipart/form-data'},
        //   //body: formData
        //   body: JSON.stringify(jsonObj)
        // }
    }
  }
}

// for use with unit tests
exports.test = {
  executePixlet,
  getPixletVersion,
  getOutputPath,
  INPUT_APPLET_PATH,
}
