import { config } from "./config.js";

const createWebrtcTransport = async (router) => {
  try {
    const webRtcTransportOptions = {
      listenIps: config.mediaSoup.webRtcTransport.listenInfos,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: 1000000,
    };

    const transport = await router.createWebRtcTransport(webRtcTransportOptions);

    console.log("WebRTC transport created successfully");

    return {
      transport,
      params: {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        sctpParameters: transport.sctpParameters,
      },
    };

  } catch (error) {
    console.error("Failed to create WebRTC transport:", error);
    throw error;
  }
};

export default createWebrtcTransport;