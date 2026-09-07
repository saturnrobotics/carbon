import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { crc32 } from "node:zlib";

const require = createRequire(import.meta.url);
const MAX_IMAGE_PIXELS = 40_000_000;

/** Bound decoded allocation before asking the installed PDF runtime to decode. */
function dimensions(bytes: Buffer, mediaType: string): [number, number] {
  if (mediaType === "image/png") {
    if (
      bytes.length < 33 ||
      bytes.readUInt32BE(8) !== 13 ||
      bytes.toString("ascii", 12, 16) !== "IHDR"
    )
      throw new Error("invoice_image_invalid");
    let offset = 8;
    let ended = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      if (length > bytes.length - offset - 12) break;
      const kind = bytes.toString("ascii", offset + 4, offset + 8);
      if (
        crc32(bytes.subarray(offset + 4, offset + 8 + length)) !==
        bytes.readUInt32BE(offset + 8 + length)
      )
        throw new Error("invoice_image_invalid");
      offset += length + 12;
      if (kind === "IEND") {
        ended = length === 0 && offset === bytes.length;
        break;
      }
    }
    if (!ended) throw new Error("invoice_image_invalid");
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  }
  if (mediaType === "image/jpeg") {
    if (bytes.length < 4 || bytes.lastIndexOf(Buffer.from([0xff, 0xd9])) < 2)
      throw new Error("invoice_image_invalid");
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (
        marker === 0x01 ||
        (marker !== undefined && marker >= 0xd0 && marker <= 0xd8)
      )
        continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if (
        marker !== undefined &&
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf
        ].includes(marker)
      ) {
        if (length < 8) break;
        return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
      }
      offset += length;
    }
  }
  if (
    mediaType === "image/webp" &&
    bytes.length >= 30 &&
    bytes.readUInt32LE(4) + 8 === bytes.length
  ) {
    const kind = bytes.toString("ascii", 12, 16);
    if (kind === "VP8X")
      return [bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1];
    if (
      kind === "VP8 " &&
      bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))
    )
      return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
    if (kind === "VP8L" && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
    }
  }
  throw new Error("invoice_image_invalid");
}

/** Signature checks identify a format; only successful decoding establishes an image. */
export async function validateInvoiceImage(
  bytes: Uint8Array,
  mediaType: string
) {
  const buffer = Buffer.from(bytes);
  const [width, height] = dimensions(buffer, mediaType);
  if (!width || !height || width * height > MAX_IMAGE_PIXELS)
    throw new Error("invoice_image_dimensions_invalid");
  let decoder: string;
  try {
    // Reuse the decoder already shipped by pdfjs-dist, through its dependency
    // boundary. Missing optional native support must fail closed before billing.
    decoder = createRequire(require.resolve("pdfjs-dist/package.json")).resolve(
      "@napi-rs/canvas"
    );
  } catch {
    throw new Error("invoice_image_decoder_unavailable");
  }
  // Native image decoders can crash or hang on corrupt input. Keep that failure
  // outside the ERP process, with bounded pixels, output, heap and wall time. The
  // child receives only the image bytes, never application credentials.
  const decoded = await new Promise<string>((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [
        "--max-old-space-size=128",
        "-e",
        `
      const {loadImage,createCanvas}=require(process.argv[1]);
      const chunks=[];process.stdin.on('data',chunk=>chunks.push(chunk));
      process.stdin.on('end',async()=>{try{const input=Buffer.concat(chunks);
        if(input.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
          const width=input.readUInt32BE(16),height=input.readUInt32BE(20),depth=input[24],color=input[25],channels={0:1,2:3,3:1,4:2,6:4}[color];
          if(!channels || ![1,2,4,8,16].includes(depth) || ([2,4,6].includes(color)&&depth<8) || (color===3&&depth===16) || input[26]!==0 || input[27]!==0 || input[28]>1) throw Error('invalid');
          const compressed=[];let palette=false;
          for(let offset=8;offset+12<=input.length;){const length=input.readUInt32BE(offset),kind=input.toString('ascii',offset+4,offset+8);if(kind==='IDAT')compressed.push(input.subarray(offset+8,offset+8+length));if(kind==='PLTE')palette=length>0&&length<=768&&length%3===0;offset+=12+length;}
          if(!compressed.length || (color===3&&!palette))throw Error('invalid');
          const passes=input[28]===1?[[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]]:[[0,0,1,1]];
          const rows=passes.map(([x,y,dx,dy])=>[Math.max(0,Math.ceil((width-x)/dx)),Math.max(0,Math.ceil((height-y)/dy))]).filter(([w,h])=>w&&h).map(([w,h])=>[Math.ceil(w*channels*depth/8),h]);
          const expected=rows.reduce((total,[bytes,count])=>total+(bytes+1)*count,0);
          const raw=require('node:zlib').inflateSync(Buffer.concat(compressed),{maxOutputLength:expected+1});if(raw.length!==expected)throw Error('invalid');
          let offset=0;for(const [bytes,count]of rows)for(let row=0;row<count;row++){if(raw[offset]>4)throw Error('invalid');offset+=bytes+1;}
        }
        const image=await loadImage(input);const canvas=createCanvas(image.width,image.height);const context=canvas.getContext('2d');context.drawImage(image,0,0);context.getImageData(0,0,1,1);process.stdout.write(JSON.stringify([image.width,image.height]),()=>process.exit(0));}catch{process.exit(1);}});
    `,
        decoder
      ],
      {
        timeout: 5000,
        killSignal: "SIGKILL",
        maxBuffer: 1024,
        encoding: "utf8",
        env: {} as NodeJS.ProcessEnv
      },
      (error, stdout) =>
        error ? reject(new Error("invoice_image_invalid")) : resolve(stdout)
    );
    child.stdin?.on("error", () => {
      /* The exit callback reports decoder failure. */
    });
    child.stdin?.end(buffer);
  });
  if (
    decoded !== JSON.stringify([width, height]) &&
    decoded !== JSON.stringify([height, width])
  )
    throw new Error("invoice_image_invalid");
}
