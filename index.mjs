import { Worker, Queue } from "bullmq"
import { temporaryFileTask } from "tempy"
import { nanoid } from "nanoid"
import { serializeError } from "serialize-error"
import Axios from "axios"
import wmatch from "wildcard-match"
import body_parser from "body-parser"
import cors from "cors"
import Redis from "ioredis"
import fs from "fs"
import Express from "express"
import process from "process"
import { exec } from "child_process"
import { promisify } from "util"

const app = Express()
const axios = Axios
const job_name = "convert"
const port = process.env.PORT || 3000
const connection = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null,
})

const queue = new Queue(job_name, { connection })

const worker = new Worker(
  job_name,
  async (job) => {
    console.log("processing job")
    console.table({ ...job.data, id: job.id })

    const {
      input_url,
      input_format,
      output_format,
      output_codec,
      output_sample_rate,
      output_bit_depth,
      output_bit_rate,
      output_dither,
      output_name,
      output_url,
      notify_url,
      context
    } = job.data

    // engine output 192k float 32-bit
    // if user chooses same, redirect to presigned get s pravim content dispositionom (filename etc)
    // choose dither (toggle)

    // -o stdout > stream to user on http response > header content disposition 

    // lahko probaš tudi input brez downloadat (problem z infinite wav file?)

    // request > download > ffmpeg > output v stream > if error > zbrišeš > if no error, all good

    await temporaryFileTask(
      async(temp_loc) => {

        const result = await convert_and_create(
          input_url,
          input_format,
          output_format,
          output_codec,
          output_sample_rate,
          output_bit_depth,
          output_bit_rate,
          output_dither,
          output_name,
          output_url,
          notify_url,
          context,
          temp_loc
        )
        
        if (result.success) {
          console.log('----- temporary converted file created -----')
          
          // send input_loc to browser
          
        } else {
          console.log(result.message)
        }


      }
    )

    await notify(notify_url, job.id, context, null)
  },
  { concurrency: parseInt(process.env.CONCURRENCY || "10"), connection }
)

worker.on("failed", (job, error) => {
  console.log({ job, error })
  notify(job.data.notify_url, job.id, job.data.context, error).catch(() => {})
})

async function convert_and_stream (
  input_url,
  input_format,
  output_format,
  output_codec,
  output_sample_rate,
  output_bit_depth,
  output_bit_rate,
  output_name,
  output_url,
  notify_url,
  context,
  temp_loc) {

  console.log('convert_and_stream')

  const codec = `-acodec ${output_codec}`
  
  let bit_depth = ''
  if (codec === flac && output_bit_depth === 16) bit_depth = '-sample_fmt s16' // 16-bit
  if (codec === flac && output_bit_depth === 24) bit_depth = '-sample_fmt s32' // 24-bit
  
  let bit_rate = ''
  if (format === 'mp3') bit_rate = `-aq ${output_bit_rate}`

  const sample_rate = `-af aresample=resampler=soxr -precision 28 -ar ${output_sample_rate}`

  let dither = ''
  let dither_in_filename = ''
  if (output_dither) {
    dither = '-dither_method shibata -precision 28' // shibata onyl available for 44.1k and 48k > fallback to triangular hp dither
    dither_in_filename = '-dither'
  }

  const filename = `${output_name}-${output_sample_rate}-${output_bit_depth}${output_bit_rate}${dither_in_filename}`

  const command = `ffmpeg -i ${input_url} -map_metadata -1 -map 0 -map -0:v -c:a ${codec} ${sample_fmt} ${bit_rate} ${sample_rate} ${dither} ${filename}.${output_format}`

  const promisifyExec = promisify(exec)
  const { stdout, stderr } = await promisifyExec(command)

  // how to check stderr

  const writer = fs.createWriteStream(temp_loc)
  stdout.data.pipe(writer)

  return new Promise((resolve, reject) => {
    let error = null
    writer.on("error", (err) => {
      error = err
      writer.close()
      reject({
        success: false,
        message: error.message
      })
    })

    writer.on("finish", () => {
      if (!error) resolve({ success: true })
    })
  })
}

async function notify(url, id, context, meta, err) {
  console.log("notifying")
  console.table({ url, id, context, err })

  await axios.post(
    url,
    { err: err ? serializeError(err) : null, context, meta, id }
  )
}

const is_domain_valid = wmatch(
  (process.env.VALID_URL_DOMAINS || "*").split(",")
)

function is_url_valid(url) {
  const parsed = new URL(url)
  return is_domain_valid(parsed.host)
}

app.use(body_parser.json())
app.use(cors())

app.post("/v1/convert-and-create", (req, res, next) => {
  const {
    input_url,
    input_format,
    output_format,
    output_codec,
    output_channels,
    output_sample_rate,
    output_bit_depth,
    output_bit_rate,
    output_url,
    notify_url,
    context
  } = req.body

  if (
    input_format !== "wav" &&
    input_format !== "flac" &&
    input_format !== "mp3"
  ) {
    throw new Error("Input format is not valid");
  }
  if (
    output_format !== "wav" &&
    output_format !== "flac" &&
    output_format !== "mp3"
  ) {
    throw new Error("Output format is not valid");
  }

  if (!input_url || !is_url_valid(input_url)) {
    throw new Error("Input URL is not valid");
  }

  if (!output_url || !is_url_valid(output_url)) {
    throw new Error("Output URL is not valid");
  }

  if (!notify_url || !is_url_valid(notify_url)) {
    throw new Error("Notify URL is not valid");
  }

  if (output_channels !== 1 && output_channels !== 2) {
    throw new Error("Channel mode is not valid");
  }

  if (output_sample_rate !== 441000 && output_sample_rate !== 48000 && output_sample_rate !== 88200 && output_sample_rate !== 96000 && output_sample_rate !== 192000) {
    throw new Error("Sample rate is not valid");
  }

  if (output_format !== 'mp3' && output_bit_depth !== 16 && output_bit_depth !== 24) {
    throw new Error("Bit depth is not valid");
  }

  if (output_codec !== 'flac' && output_codec !== 'pcm_s16le' && output_codec !== 'pcm_s32le' && output_codec !== 'mp3') {
    throw new Error("Codec is not valid");
  }

  if (output_format === 'mp3' && output_bit_rate !== '320') {
    throw new Error("Bit rate is not valid");
  }

  queue
    .add(
      new Date().toISOString(),
      {
        input_url,
        input_format,
        output_format,
        output_codec,
        output_channels,
        output_sample_rate,
        output_bit_depth,
        output_bit_rate,
        output_url,
        notify_url,
        context
      },
      { jobId: nanoid() }
    )
    .then((job) => res.json(job.id))
    .catch(next)
})

app.listen(port, () => {
  console.log(`👋 Express application listening on port ${port}!`)
})
