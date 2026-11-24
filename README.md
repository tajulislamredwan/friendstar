FriendStar

A Modern, Mobile-First Messaging Platform

FriendStar is a modern, mobile-first messaging application designed to make digital communication simple, connected, and privacy-conscious.

It brings together real-time private messaging, group conversations, status updates, voice and video calls, user discovery, and AI-powered assistance in one platform.

<p align="center">
  <strong>Private Conversations. Meaningful Connections.</strong>
</p><p align="center">
  <a href="https://chat.friendstar.workers.dev">Live Application</a> ·
  <a href="https://github.com/tajulislamredwan/friendstar">GitHub Repository</a>
</p>---


Overview

FriendStar is a full-stack messaging platform built with a mobile-first approach and a modern web technology stack.

The application supports real-time communication, user profiles, private and group conversations, multimedia sharing, voice and video calling, and AI-assisted interactions.

FriendStar is designed to support independent deployment and infrastructure configuration, making it suitable for customization and future product development.

Live Application

Production URL: https://chat.friendstar.workers.dev

---

Key Features

1. Authentication and User Accounts

- User registration and login
- Username- and email-based authentication
- Session persistence
- Refresh token rotation
- User profiles with profile photos and biographies
- Secure password reset workflow

2. Private Messaging

- Real-time one-to-one messaging
- Message delivery indicators
- Sent, delivered, and read status
- Typing indicators
- Online and last-seen status
- Unread message counters
- Message search
- Jump-to-message functionality

3. Group Communication

- Group chat creation
- Group profile photos
- Group administration
- Member addition and removal
- Admin promotion
- Group exit functionality
- Group message notifications
- Read status indicators

4. Multimedia Sharing

- Image sharing
- Document and file sharing
- File preview before sending
- Image viewer
- Downloadable attachments
- File type and size validation

Current application upload limit: 10 MB per attachment.

5. Status Updates

- Text status updates
- Photo status updates
- 24-hour automatic expiration
- Status viewer
- Viewers list
- Seen indicators

6. Voice and Video Calls

- One-to-one voice calls
- One-to-one video calls
- Group voice calls
- Group video calls
- Call notifications
- Mute and camera controls
- Camera switching
- Call history
- Call minimization

Group calls currently support up to six participants.

7. FriendStar ID and People Directory

- Unique FriendStar IDs ("FS-XXXXXX")
- Public profile links
- People directory
- User discovery
- Profile sharing
- Search by FriendStar ID or email

8. AI Assistant and Bots

FriendStar includes multiple helper bots:

- Star AI: AI-powered assistant supporting English and Bangla.
- Nova Guide: Welcomes and guides new users.
- Echo Bot: Automated interaction bot.
- Lucky: Additional interactive bot.

Star AI uses the Cloudflare Workers AI binding.

9. Privacy Controls

Users can configure:

- Last-seen visibility
- Profile photo visibility
- Read receipts
- Who can send messages
- Search visibility
- User blocking

10. User Interface

- Mobile-first responsive design
- Light theme
- Dark theme
- System theme
- Desktop and mobile layouts
- Notification center
- Browser notification support

---

Privacy and Security

FriendStar incorporates multiple security and privacy-oriented mechanisms.

Documented security features include:

- Password hashing using bcrypt
- JWT-based access authentication
- Refresh token rotation
- Hashed refresh-token storage
- HTTP-only refresh-token cookies
- Input validation using Zod
- API rate limiting
- Conversation membership authorization
- File type and size validation
- Signed file URLs in the Cloudflare deployment
- Security headers
- Privacy-aware profile information filtering

The application also restricts administrative access through the "OWNER_EMAILS" configuration.

Important: Authentication security, transport encryption, encrypted storage, and End-to-End Encryption are different security properties. They should not be treated as interchangeable.

---

Encryption Architecture

FriendStar supports encrypted WebRTC communication for voice and video calls, as documented in the current project documentation.

End-to-End Encryption (E2EE) for private messages and file attachments must be documented separately from call encryption.

A complete E2EE implementation should ensure that:

1. Encryption takes place on the sender's device.
2. Decryption takes place only on authorized recipient devices.
3. The server cannot access plaintext message content.
4. Encryption keys remain under the control of the communicating users.
5. Group conversations use an appropriate key-management mechanism.

The current repository documentation does not yet establish these properties for all messaging and file-sharing features.

Before advertising FriendStar as a fully E2EE messaging platform, the implementation and key-management flow should be verified and documented.

---

Technology Stack

FriendStar uses a modern TypeScript-based technology stack.

Layer| Technologies
Language| TypeScript
Frontend| React 19
Build Tool| Vite
Styling| Tailwind CSS v4
State Management| Zustand
Routing| React Router
Backend| Node.js, Express 5
Realtime Communication| Socket.IO / WebSockets
Database| SQLite
Edge Database Runtime| Cloudflare Durable Objects SQLite
Validation| Zod
Authentication| JWT, bcrypt
Voice and Video| WebRTC
AI Integration| Cloudflare Workers AI
Deployment| Cloudflare Workers
Package Manager| pnpm

---

System Architecture

FriendStar supports two application runtime environments.

Standard Node.js Runtime

The standard runtime uses:

- Express API server
- SQLite database
- Socket.IO real-time communication
- React frontend

Cloudflare Runtime

The Cloudflare deployment uses:

- Cloudflare Workers for application hosting
- Workers Static Assets for frontend delivery
- Durable Objects for backend application services
- SQLite-backed Durable Object storage
- Native WebSockets for real-time communication
- Workers AI for AI-assisted features

Communication Flow

              FriendStar Client
                     |
                     |
              Cloudflare Worker
                     |
          +----------+----------+
          |                     |
     Static Assets        API / WebSockets
                                |
                         FriendStarHub
                                |
                        Durable Object
                                |
                         SQLite Storage
                                |
                    Application Services
                                |
                     Workers AI (Optional)

Voice and video communication use WebRTC. An optional TURN relay can be configured for connectivity where direct peer-to-peer communication is unavailable.

---

Project Structure

friendstar/
│
├── android-wrapper/
│
├── apps/
│   ├── server/
│   │   └── src/
│   │
│   ├── web/
│   │   └── src/
│   │
│   └── worker/
│       ├── src/
│       ├── static/
│       └── scripts/
│
├── packages/
│   └── shared/
│       └── src/
│
├── docs/
│   ├── DESIGN.md
│   ├── PHASE2.md
│   └── PHASE3.md
│
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
└── README.md

---

Getting Started

Prerequisites

Install the following:

- Node.js 22.5 or later
- pnpm 9 or later
- Git

The project has been tested on Node.js 24.

1. Clone the Repository

git clone https://github.com/tajulislamredwan/friendstar.git

cd friendstar

2. Install Dependencies

pnpm install

3. Configure Local Environment

Set a demo password in your local environment before running the seed command.

DEMO_PASSWORD=your_local_demo_password

Use a temporary local-only password. Never use real account credentials.

4. Initialize Demo Data

pnpm seed

Warning: The seed command wipes the local database and creates synthetic demo accounts. Never run it against production data.

5. Start Development Server

pnpm dev

The development services run at:

- Frontend: "http://localhost:5173"
- API: "http://localhost:4000"

6. Production-Style Local Run

pnpm build

pnpm start

Open:

http://localhost:4000

---

Environment Configuration

The following variables are documented for the standard Node.js runtime.

Variable| Default| Description
"PORT"| "4000"| API server port
"JWT_SECRET"| Generated locally| JWT signing secret
"REQUIRE_JWT_SECRET"| Not enabled| Require an explicitly configured JWT secret
"WEB_ORIGIN"| "http://localhost:5173"| Allowed frontend origin
"DATA_DIR"| Server data directory| Database directory
"DB_FILE"| "friendstar.db"| SQLite database file
"AUTH_RATE_LIMIT"| "20"| Authentication rate limit
"API_RATE_LIMIT"| "300"| API rate limit
"UPLOAD_DIR"| Server uploads directory| File upload storage location
"OWNER_EMAILS"| Deployment-specific| Authorized admin email addresses

Cloudflare deployment secrets and bindings are configured separately through Wrangler and the Cloudflare dashboard.

Security Recommendations

- Generate a strong, unique JWT secret.
- Never commit secrets to GitHub.
- Keep production and development credentials separate.
- Restrict administrative access.
- Review third-party service credentials before deployment.
- Rotate credentials if they are exposed.

---

Cloudflare Deployment

FriendStar supports deployment using Cloudflare Workers.

Prerequisites

- A Cloudflare account
- Wrangler CLI
- Access to the target Cloudflare account
- Properly configured Worker bindings and secrets

1. Authenticate with Cloudflare

npx wrangler login

2. Navigate to the Worker Directory

cd apps/worker

3. Build the Web Application

pnpm build:web

4. Build the Worker

pnpm build

5. Deploy

npx wrangler deploy

6. Run Locally

pnpm build:web

pnpm build

npx wrangler dev --port 8787

Open:

http://localhost:8787

Cloudflare Configuration

Configure the following according to the deployment environment:

- Worker name
- Worker account
- Durable Objects bindings
- Durable Objects migrations
- Workers AI binding
- Authorized owner emails
- Optional TURN credentials
- Custom domain and DNS
- Production secrets

Optional TURN configuration uses:

TURN_KEY_ID
TURN_KEY_API_TOKEN

Do not publish secret values in source code or documentation.

---

Android Application

FriendStar includes an Android wrapper project.

The application also provides access to a direct-install Android beta APK through its web application.

Live application: https://chat.friendstar.workers.dev

Android package configuration and signing should be reviewed before preparing a production release.

---

Admin Dashboard

FriendStar includes an owner-restricted administrative interface.

Admin route:

/admin

The documented dashboard features include:

- Account IDs and email addresses
- Account creation dates
- Successful sign-in dates
- Aggregate daily account statistics
- In-app announcements
- Announcement preview
- Recipient count
- Send confirmation
- Announcement audit history

Administrative access is controlled by:

OWNER_EMAILS

The documented admin interface does not expose private chat contents or user passwords.

---

Testing

FriendStar includes automated checks for application functionality.

Type Checking

pnpm typecheck

General Tests

pnpm test

Cloudflare Smoke Tests

node scripts/cf-smoke.mjs

Production Checks

python3 scripts/prod_check.py

Phase 2 Checks

node scripts/phase2-smoke.mjs

Phase 2 Browser Tests

python3 scripts/e2e_phase2.py

Phase 3 Checks

node scripts/phase3-smoke.mjs

Phase 3 Browser Tests

python3 scripts/e2e_phase3.py

Run tests in an appropriate development or staging environment. Review each script's arguments before running it against a deployed instance.

---

Storage and Infrastructure

FriendStar's deployment model determines where application data is stored.

In the documented Cloudflare deployment:

- Account and application data are stored in Durable Object SQLite storage.
- Uploaded files are stored in SQLite-backed chunks.
- Authentication and application services run through the Worker and Durable Object architecture.
- AI-assisted features use the configured Workers AI service.
- WebRTC calls may use an optional TURN relay.

The application also includes an account deletion endpoint in the Cloudflare build:

DELETE /api/me

This endpoint requires the user's password and deletes the account and associated data described in the project documentation.

Note: Data persistence, encryption at rest, transport encryption, and E2EE are separate matters. Deployment owners should review their storage and service configuration.

---

Customization

FriendStar can be adapted for different deployment environments and branding requirements.

Potential customization areas include:

- Application name
- Logo and favicon
- Brand colors
- Domain and subdomain
- Android application identity
- Admin access
- AI configuration
- Infrastructure and storage
- Privacy and terms pages
- Application interface

Some changes may require frontend, backend, or Android build modifications.

---

Known Limitations

The current documented deployment has several infrastructure considerations:

- The Cloudflare deployment uses a single Durable Object for application data and services.
- A single Durable Object may become a scalability bottleneck under heavy concurrent usage.
- Group calls currently support up to six participants.
- File uploads are limited to 10 MB.
- Workers AI usage is subject to the configured service allowance and limits.
- The Cloudflare free-plan limits and pricing may change over time.

For larger deployments, architecture and infrastructure capacity should be reviewed before production scaling.

---

License and Ownership

The repository's license and intellectual-property terms should be reviewed before redistribution, commercial use, or modification.

Third-party dependencies remain subject to their respective licenses.

For commercial acquisition, white-label deployment, source-code transfer, or custom licensing, the applicable terms should be agreed upon separately in writing.

---

Contact

Project: FriendStar

Developed by: INNOVERSA Technologies

Developer: Tajul Islam Redwan

GitHub: https://github.com/tajulislamredwan

Live Application: https://chat.friendstar.workers.dev

---

<p align="center">
  <strong>FriendStar — Private Conversations. Meaningful Connections.</strong>
  <br />
  Built with modern web technologies.
</p>