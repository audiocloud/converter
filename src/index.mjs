import Express from "express"
import process from "process"
import wmatch from "wildcard-match"
import body_parser from "body-parser"
import cors from "cors"
import tempfile from 'tempfile'
import { promisify } from "util"
import { exec } from "child_process"
import fs from "fs"
import contentDisposition from "content-disposition"

const app = Express()
const port = process.env.PORT || 3000

const is_domain_valid = wmatch(
  (process.env.VALID_URL_DOMAINS || "*").split(",")
)

function is_url_valid(url) {
  const parsed = new URL(url)
  return is_domain_valid(parsed.host)
}

app.use(body_parser.json())
app.use(cors())

app.get("/v1/convert", async (req, res, next) => {

  const { encodedParams } = req.query

  const decodeBase64 = (data) => {
    return Buffer.from(data, 'base64').toString('ascii')
  }

  const decodedParams = decodeBase64(encodedParams)
  const parsedParams = JSON.parse(decodedParams)

  const {
    input_url,
    input_format,
    input_name,
    output_format,
    output_channels,
    output_sample_rate,
    output_bit_depth,
    output_bit_rate,
    output_dither,
  } = parsedParams

  try {

    // CHECK INPUT DATA

    if (
      input_format !== "wav" &&
      input_format !== "flac" &&
      input_format !== "mp3")                                                               throw new Error("Input format is not valid")
    if (!input_url || !is_url_valid(input_url))                                             throw new Error("Input URL is not valid")
    if (typeof input_name !== 'string' || input_name === '')                                throw new Error("Input name is not valid")
    if (output_format !== "wav" && output_format !== "flac" && output_format !== "mp3")     throw new Error("Output format is not valid")
    if (output_channels !== 1 && output_channels !== 2)                                     throw new Error("Output channel mode is not valid")
    if (
      output_sample_rate !== 44100 &&
      output_sample_rate !== 48000 &&
      output_sample_rate !== 88200 &&
      output_sample_rate !== 96000 &&
      output_sample_rate !== 192000)                                                        throw new Error("Output sample rate is not valid")
    if (
      output_format !== 'mp3' &&
      output_bit_depth !== 16 &&
      output_bit_depth !== 24)                                                              throw new Error("Output bit depth is not valid")
    if (output_format === 'mp3' && output_bit_rate !== '320')                               throw new Error("Output bit rate is not valid")
    if (typeof output_dither !== 'boolean')                                                 throw new Error("Output dither is not valid")

    // PREPARE COMMAND
  
    console.log('1 ----- setting up conversion command')

    let codec = `-c:a ${output_format}`
    if (output_format === 'wav' && output_bit_depth === 16) codec = '-c:a pcm_s16le'
    if (output_format === 'wav' && output_bit_depth === 24) codec = '-c:a pcm_s32le'
    
    let bit_depth = ''
    if (output_format === 'flac' && output_bit_depth === 16) bit_depth = '-sample_fmt s16' // 16-bit
    if (output_format === 'flac' && output_bit_depth === 24) bit_depth = '-sample_fmt s32' // 24-bit
    
    let bit_rate = ''
    if (output_format === 'mp3') bit_rate = `-aq ${output_bit_rate}`
  
    const sample_rate = `-af aresample=resampler=soxr -precision 28 -ar ${output_sample_rate}`
  
    let dither = ''
    let dither_in_filename = ''
    if (output_dither) {
      dither = '-dither_method shibata' // shibata onyl available for 44.1k and 48k > fallback to triangular hp dither ???
      dither_in_filename = '-dither'
    }

    const temp_file = tempfile(`.${output_format}`)
  
    const filename = `${input_name}-${output_sample_rate}-${output_bit_depth}${output_bit_rate}${dither_in_filename}`
  
    console.log('------------------------')
    console.log('Command settings:')
    console.log('input_url:  ', input_url)
    console.log('codec:      ', codec)
    console.log('bit_depth:  ', bit_depth)
    console.log('bit_rate:   ', bit_rate)
    console.log('sample_rate:', sample_rate)
    console.log('dither:     ', dither)
    console.log('filename:   ', filename)
    console.log('out_format: ', output_format)
    console.log('------------------------')

    const command = `ffmpeg -i "${input_url}" -map_metadata -1 -map 0 -map -0:v ${codec} ${bit_depth} ${bit_rate} ${sample_rate} ${dither} ${temp_file}`

    // RUN COMMAND

    console.log('2 ----- converting with command:', command)
  
    const promisifyExec = promisify(exec)
    const { stdout, stderr } = await promisifyExec(command)

    console.log('------------------------')
    console.log('ffmpeg stdout:', stdout)
    console.log('------------------------')
    console.log('ffmpeg stderr:', stderr)
    console.log('------------------------')

    // how to check stderr

    const file_stats = await fs.promises.stat(temp_file)
    
    const headers = {
      'Content-Type': `audio/${output_format}`,
      'Content-Disposition': contentDisposition(`${filename}.${output_format}`),
      'Content-Length': file_stats.size
    }

    console.log('Headers set:', headers)

    console.log('Creating stream...')

    res.writeHead(201, headers)    
    const readStream = fs.createReadStream(temp_file)
    
    readStream.on('error', () => {
      console.log('--------- STREAM ERROR ---------')
    })
    readStream.on('open', () => {
      console.log('Read stream open...')
      console.log('Piping...')
      readStream.pipe(res)
    })
    
    readStream.on('close', () => {
      console.log('Read stream closing...')
      console.log('Ending response...')
      res.end()
    })
    
  } catch (error) {
    console.log(error.message)
    res.status(500).json({
      success: false,
      message: error.message
    })
  }
})

app.listen(port, () => {
  console.log(`👋 Express application listening on port ${port}!`)
})