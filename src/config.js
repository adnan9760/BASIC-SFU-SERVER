import os from "os";

export const config = {
  listenIp: "0.0.0.0",
  listenPort: 8080,

  mediaSoup: {
    numWorkers: os.cpus().length,

    worker: {
      logLevel: "debug",
      logTags: [
        "info",
        "ice",
        "dtls",
        "rtp",
        "srtp",
        "rtcp",
        "rtx",
      ],
      rtcMinPort: 10000,
      rtcMaxPort: 10100,
    },

    router: {
      mediaCodecs: [
        {
          kind: "audio",
          mimeType: "audio/opus",
          clockRate: 48000,
          channels: 2,
        },
        {
          kind: "video",
          mimeType: "video/VP8",
          clockRate: 90000,
          parameters: {
            "x-google-start-bitrate": 1000,
          },
        },
      ],
    },

    
    // config.js
webRtcTransport: {
  listenInfos: [
    {
      protocol: "udp",
      ip: "127.0.0.1",
      announcedAddress: "127.0.0.1",
    }
  ],
  enableUdp: true,
  enableTcp: false,
  preferUdp: true,
}
  },
};