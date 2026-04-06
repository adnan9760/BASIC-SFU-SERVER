import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { createWorker } from "./worker.js";
import createWebrtcTransport from "./createWebrtcTransport.js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import dotenv from 'dotenv';
dotenv.config();

// ─── AWS S3 config ────────────────────────────────────────────────────────────

const s3 = new S3Client({
    region:process.env.S3_REGION,
    credentials: {
        accessKeyId: process.env.accessKeyId,
        secretAccessKey: process.env.secretAccessKey,
    },
});

// ─── Per-socket state ─────────────────────────────────────────────────────────
// Map<socket, { producerTransport, consumerTransport, producer, consumer }>
const peers = new Map();

// All active producers — shared so any subscriber can consume any producer
// Map<producerId, producer>
const producers = new Map();

// Active FFmpeg sessions — one per producer
// Map<producerId, { process, watcher, hlsDir, mp4Path }>
const ffmpegSessions = new Map();

let mediasoupRouter;

// ─── Main WebSocket handler ───────────────────────────────────────────────────
export const WebSocketConnection = async (wss) => {
    try {
        mediasoupRouter = await createWorker();
        console.log("Mediasoup router created");
    } catch (error) {
        console.error("Failed to create mediasoup worker:", error);
        throw error;
    }

    wss.on("connection", (socket) => {
        console.log("New client connected");

        peers.set(socket, {
            producerTransport: null,
            consumerTransport: null,
            producer: null,
            consumer: null,
        });

        socket.on("message", (message) => {
            const data = JSON.parse(message.toString());
            console.log("Received:", data.type);

            switch (data.type) {
                case "getRouterRtpCapabilities":   onGetRouterRtpCapabilities(socket);          break;
                case "createProducerTransport":    onCreateProducerTransport(socket);           break;
                case "connectProducerTransport":   onConnectProducerTransport(data, socket);    break;
                case "produce":                    onProduce(data, socket, wss);                break;
                case "createConsumerTransport":    onCreateConsumerTransport(socket);           break;
                case "connectConsumerTransport":   onConnectConsumerTransport(data, socket);    break;
                case "consume":                    onConsume(data, socket);                     break;
                case "resume":                     onResume(socket);                            break;
            }
        });

        socket.on("close", () => {
            console.log("Client disconnected — cleaning up");
            const peer = peers.get(socket);
            if (peer) {
                // Stop FFmpeg if this socket owned a producer
                if (peer.producer) {
                    stopFFmpeg(peer.producer.id);
                    producers.delete(peer.producer.id);
                }
                peer.producer?.close();
                peer.consumer?.close();
                peer.producerTransport?.close();
                peer.consumerTransport?.close();
            }
            peers.delete(socket);
        });
    });
};

// ─── Handshake ────────────────────────────────────────────────────────────────
const onGetRouterRtpCapabilities = (socket) => {
    send(socket, "routerRtpCapabilities", mediasoupRouter.rtpCapabilities);
};

// ─── Publish ──────────────────────────────────────────────────────────────────
const onCreateProducerTransport = async (socket) => {
    try {
        const { transport, params } = await createWebrtcTransport(mediasoupRouter);

        transport.on("icestatechange",  (s) => console.log(`[producer ${transport.id}] ICE:`, s));
        transport.on("dtlsstatechange", (s) => {
            console.log(`[producer ${transport.id}] DTLS:`, s);
            if (s === "closed") transport.close();
        });

        peers.get(socket).producerTransport = transport;
        send(socket, "producerTransportCreated", params);
    } catch (error) {
        console.error("createProducerTransport error:", error);
        send(socket, "error", { message: error.message });
    }
};

const onConnectProducerTransport = async (data, socket) => {
    try {
        const { producerTransport } = peers.get(socket);
        await producerTransport.connect({ dtlsParameters: data.data.dtlsParameters });
        send(socket, "producerTransportConnected", "connected");
    } catch (error) {
        console.error("connectProducerTransport error:", error);
    }
};

const onProduce = async (data, socket, wss) => {
    try {
        const { kind, rtpParameters } = data.data;
        const { producerTransport } = peers.get(socket);

        const producer = await producerTransport.produce({ kind, rtpParameters });
        peers.get(socket).producer = producer;
        producers.set(producer.id, producer);

        console.log("Producer created:", producer.id, kind);

        producer.on("transportclose", () => {
            console.log("Producer transport closed:", producer.id);
            stopFFmpeg(producer.id);
            producers.delete(producer.id);
        });

        // Confirm to publisher
        send(socket, "produced", { producerId: producer.id });

        // Notify all other clients so they can auto-subscribe
        broadcast(wss, socket, "newProducer", { producerId: producer.id });

        // Start FFmpeg recording + HLS pipeline for this producer
        // Small delay to let WebRTC stabilise first
        setTimeout(() => startFFmpeg(producer.id), 2000);

    } catch (error) {
        console.error("produce error:", error);
        send(socket, "error", { message: error.message });
    }
};

// ─── Subscribe ────────────────────────────────────────────────────────────────
const onCreateConsumerTransport = async (socket) => {
    try {
        const { transport, params } = await createWebrtcTransport(mediasoupRouter);

        transport.on("icestatechange",  (s) => console.log(`[consumer ${transport.id}] ICE:`, s));
        transport.on("dtlsstatechange", (s) => {
            console.log(`[consumer ${transport.id}] DTLS:`, s);
            if (s === "closed") transport.close();
        });

        peers.get(socket).consumerTransport = transport;
        send(socket, "consumerTransportCreated", params);
    } catch (error) {
        console.error("createConsumerTransport error:", error);
        send(socket, "error", { message: error.message });
    }
};

const onConnectConsumerTransport = async (data, socket) => {
    try {
        const { consumerTransport } = peers.get(socket);
        await consumerTransport.connect({ dtlsParameters: data.data.dtlsParameters });
        send(socket, "consumerTransportConnected", "connected");
    } catch (error) {
        console.error("connectConsumerTransport error:", error);
    }
};

const onConsume = async (data, socket) => {
    try {
        const { rtpCapabilities, producerId } = data.data;

        const producer = producers.get(producerId);
        if (!producer) throw new Error(`Producer not found: ${producerId}`);

        if (!mediasoupRouter.canConsume({ producerId, rtpCapabilities })) {
            throw new Error("Cannot consume: incompatible RTP capabilities");
        }

        const { consumerTransport } = peers.get(socket);
        if (!consumerTransport) throw new Error("Consumer transport not created yet");

        const consumer = await consumerTransport.consume({
            producerId,
            rtpCapabilities,
            paused: true,
        });

        peers.get(socket).consumer = consumer;
        console.log("Consumer created:", consumer.id, "for producer:", producerId);

        consumer.on("transportclose", () => console.log("Consumer transport closed"));
        consumer.on("producerclose",  () => {
            send(socket, "producerClosed", { producerId });
        });

        send(socket, "consumed", {
            id:            consumer.id,
            producerId,
            kind:          consumer.kind,
            rtpParameters: consumer.rtpParameters,
        });
    } catch (error) {
        console.error("consume error:", error);
        send(socket, "error", { message: error.message });
    }
};

const onResume = async (socket) => {
    try {
        const { consumer } = peers.get(socket);
        if (!consumer) throw new Error("No consumer for this socket");
        await consumer.resume();
        await consumer.requestKeyFrame();
        send(socket, "resumed", "resumed");
    } catch (error) {
        console.error("resume error:", error);
    }
};

// ─── FFmpeg pipeline ──────────────────────────────────────────────────────────
//
// For each producer:
//   1. Create a PlainTransport — unencrypted UDP, no WebRTC overhead
//   2. Consume the producer through it — mediasoup forwards plain RTP to a local port
//   3. Write an SDP file describing the codec so FFmpeg knows what to expect
//   4. Spawn FFmpeg with two outputs:
//      a) HLS  → /tmp/hls/<producerId>/*.ts + stream.m3u8
//      b) MP4  → /tmp/recordings/<producerId>.mp4
//   5. Watch the HLS dir — upload every .ts and .m3u8 to S3 as they appear
//   6. On stream end — upload the full MP4 to S3
//
const startFFmpeg = async (producerId) => {
    const producer = producers.get(producerId);
    if (!producer) {
        console.error("startFFmpeg: producer not found", producerId);
        return;
    }

    try {
        // ── 1. PlainTransport on a free local UDP port ──────────────────────
        const RTP_PORT  = await getFreePort(5100);   // video
        const RTCP_PORT = RTP_PORT + 1;
       

        const plainTransport = await mediasoupRouter.createPlainTransport({
            listenIp:  { ip: "127.0.0.1", announcedIp: "127.0.0.1" },
            rtcpMux:   false,   // separate RTCP port for FFmpeg compatibility
            comedia:   false,
            enableTcp: true,
  enableUdp: false,
        });

        // const RTP_PORT  = plainTransport.;
        // const RTCP_PORT = plainTransport.rtcpTuple.localPort;

        await plainTransport.connect({
            ip:       "127.0.0.1",
            port:     RTP_PORT,
            rtcpPort: RTCP_PORT,

        });

        // ── 2. Consume the producer through the plain transport ─────────────
        const plainConsumer = await plainTransport.consume({
            producerId,
            rtpCapabilities: mediasoupRouter.rtpCapabilities,
            paused:          false,
        });

        const codec = plainConsumer.rtpParameters.codecs[0];
        const pt    = codec.payloadType;
        const ssrc  = plainConsumer.rtpParameters.encodings[0].ssrc;

        console.log(`FFmpeg: producer ${producerId} → port ${RTP_PORT}, PT=${pt}, SSRC=${ssrc}`);

        // ── 3. Build SDP ────────────────────────────────────────────────────
        const sdp = buildSDP(RTP_PORT, RTCP_PORT, pt, ssrc, codec);
       const sdpPath = `./input_${producerId}.sdp`;
        fs.writeFileSync(sdpPath, sdp);

        // ── 4. Create output dirs ───────────────────────────────────────────
        const hlsDir  = `/tmp/hls/${producerId}`;
        const mp4Path = `/tmp/recordings/${producerId}.mp4`;
        fs.mkdirSync(hlsDir,                    { recursive: true });
        fs.mkdirSync("/tmp/recordings",         { recursive: true });

        // ── 5. Spawn FFmpeg ─────────────────────────────────────────────────
 const ffmpegArgs = [
  "-protocol_whitelist", "file,udp,rtp",

  "-fflags", "+genpts",
  "-thread_queue_size", "512",
  "-max_delay", "1000000",
  "-reorder_queue_size", "2000",

  "-i", sdpPath,

  "-c:v", "libx264",
  "-preset", "ultrafast",
  "-tune", "zerolatency",

  "-r", "25",
  "-s", "854x480",
  "-b:v", "800k",
  "-maxrate", "800k",
  "-bufsize", "1600k",

  "-g", "25",
  "-keyint_min", "25",

  "-f", "hls",
  "-hls_time", "4",
  "-hls_list_size", "10",
  "-hls_flags", "delete_segments+append_list",
  "-hls_segment_filename", `${hlsDir}/seg%05d.ts`,
  `${hlsDir}/stream.m3u8`,
];

        const ffmpegProcess = spawn("ffmpeg", ffmpegArgs);

        ffmpegProcess.stderr.on("data", (d) =>
            console.log(`[ffmpeg ${producerId.slice(0,8)}]`, d.toString().trim())
        );

        ffmpegProcess.on("close", (code) => {
            console.log(`FFmpeg exited (${code}) for producer ${producerId}`);
            uploadMP4(producerId, mp4Path);
            cleanupFFmpeg(producerId, sdpPath, plainTransport, plainConsumer);
        });

        // ── 6. Watch HLS dir — upload segments as they appear ───────────────
        const watcher = fs.watch(hlsDir, async (event, filename) => {
            if (!filename) return;
            if (!filename.endsWith(".ts") && !filename.endsWith(".m3u8")) return;

            const filePath = path.join(hlsDir, filename);
            if (!fs.existsSync(filePath)) return;

            const s3Key      = `streams/${producerId}/${filename}`;
            const contentType = filename.endsWith(".m3u8")
                ? "application/x-mpegURL"
                : "video/mp2t";

            try {
                await s3.send(new PutObjectCommand({
                    Bucket:      process.env.S3_BUCKET,
                    Key:         s3Key,
                    Body:        fs.readFileSync(filePath),
                    ContentType: contentType,
                    // Allow CloudFront to cache .ts segments but revalidate .m3u8 quickly
                    CacheControl: filename.endsWith(".m3u8")
                        ? "max-age=2"
                        : "max-age=30",
                }));
                console.log(`S3: uploaded ${s3Key}`);
            } catch (err) {
                console.error(`S3 upload failed for ${s3Key}:`, err.message);
            }
        });

        // Store session so we can clean up on disconnect
        ffmpegSessions.set(producerId, {
            process:  ffmpegProcess,
            watcher,
            hlsDir,
            mp4Path,
            plainTransport,
            plainConsumer,
        });

        // Tell anyone who wants the HLS URL where to find it
        const hlsUrl = `${process.env.CF_DOMAIN}/streams/${producerId}/stream.m3u8`;
        console.log(`HLS live URL: ${hlsUrl}`);

    } catch (error) {
        console.error("startFFmpeg error:", error);
    }
};

// ── Upload full MP4 to S3 once the stream ends ────────────────────────────────
const uploadMP4 = async (producerId, mp4Path) => {
    if (!fs.existsSync(mp4Path)) return;

    try {
        const s3Key = `recordings/${producerId}.mp4`;
        const upload = new Upload({
            client: s3,
            params: {
                Bucket:      process.env.S3_BUCKET,
                Key:         s3Key,
                Body:        fs.createReadStream(mp4Path),
                ContentType: "video/mp4",
            },
        });
        upload.on("httpUploadProgress", (p) =>
            console.log(`S3 MP4 upload ${producerId.slice(0,8)}: ${p.loaded} bytes`)
        );
        await upload.done();
        console.log(`S3: MP4 uploaded → recordings/${producerId}.mp4`);
    } catch (err) {
        console.error("MP4 upload error:", err.message);
    }
};

// ── Stop an active FFmpeg session ─────────────────────────────────────────────
const stopFFmpeg = (producerId) => {
    const session = ffmpegSessions.get(producerId);
    if (!session) return;

    console.log("Stopping FFmpeg for producer:", producerId);
    session.watcher.close();
    session.process.kill("SIGTERM");
    ffmpegSessions.delete(producerId);
};

const cleanupFFmpeg = (producerId, sdpPath, plainTransport, plainConsumer) => {
    try { plainConsumer.close(); }  catch (_) {}
    try { plainTransport.close(); } catch (_) {}
    try { fs.unlinkSync(sdpPath); } catch (_) {}
};

// ─── SDP builder ─────────────────────────────────────────────────────────────
const buildSDP = (rtpPort, rtcpPort, pt, ssrc, codec) => {
    const isVideo = codec.kind === "video" || codec.mimeType.toLowerCase().includes("vp8");
    const mediaType  = isVideo ? "video" : "audio";
    const clockRate  = codec.clockRate;
    const codecName  = codec.mimeType.split("/")[1].toUpperCase();
    const channels   = codec.channels ? `/${codec.channels}` : "";

    return [
        "v=0",
        "o=- 0 0 IN IP4 127.0.0.1",
        "s=mediasoup-ffmpeg",
        "c=IN IP4 127.0.0.1",
        "t=0 0",

        // Media
        `m=${mediaType} ${rtpPort} RTP/AVP ${pt}`,

        // RTP mapping
        `a=rtpmap:${pt} ${codecName}/${clockRate}${channels}`,

        // IMPORTANT FIXES
        "a=rtcp-mux",   // RTCP multiplexing
        `a=fmtp:${pt} max-fr=30;max-fs=12288`, // smoother decoding

        // SSRC
        ssrc ? `a=ssrc:${ssrc} cname:mediasoup` : "",

        "a=recvonly",
    ].filter(Boolean).join("\r\n") + "\r\n";
};

// ─── Find a free local UDP port ───────────────────────────────────────────────
// Simple incrementing allocator — good enough for a single server
let nextPort = 5100;
const getFreePort = async (hint) => {
    const port = nextPort;
    nextPort += 2; // reserve port+1 for RTCP
    return port;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const broadcast = (wss, senderSocket, type, data) => {
    const msg = JSON.stringify({ type, data });
    wss.clients.forEach((client) => {
        if (client !== senderSocket && client.readyState === 1) {
            client.send(msg);
        }
    });
};

const send = (socket, type, data) => {
    socket.send(JSON.stringify({ type, data }));
};