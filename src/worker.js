import { config } from "./config.js";
import mediasoup from 'mediasoup';

export const createWorker = async () =>{
    const worker = await mediasoup.createWorker({
        logLevel: config.mediaSoup.worker.logLevel,
        logTags: config.mediaSoup.worker.logTags,
        rtcMinPort: config.mediaSoup.worker.rtcMinPort,
        rtcMaxPort: config.mediaSoup.worker.rtcMaxPort,
    });
    worker.on('died',()=>{
        console.error('mediasoup worker died, exiting in 2 seconds... [pid:%d]',worker.pid);
        setTimeout(() => process.exit(1),2000);
    });
    
    const mediaCodecs = config.mediaSoup.router.mediaCodecs;
    const router = await worker.createRouter({ mediaCodecs });
    return router;
}
