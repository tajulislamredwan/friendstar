import http from 'node:http';
import { config } from './config.ts';
import { createApp } from './app.ts';
import { attachRealtime } from './realtime/socket.ts';

const server = http.createServer(createApp());
attachRealtime(server);

server.listen(config.port, () => {
  console.log(`✦ FriendStar API listening on http://localhost:${config.port} (${config.isProd ? 'production' : 'development'})`);
});
