// Local PeerJS broker so the phone-camera tests do not depend on the public one.
import { PeerServer } from 'peer';

const port = Number(process.env.PEER_PORT || 9000);
PeerServer({ port, path: '/', host: '127.0.0.1' }, () => console.log(`peer server on ${port}`));
