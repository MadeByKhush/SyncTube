# SyncTube

A real-time YouTube watch party application.

## 💻 Technology Stack

- **Frontend**: HTML5, CSS3, Vanilla JavaScript
- **Backend**: Node.js, Express, Socket.io
- **Deployment**: Single Monolith (Frontend served by Backend)

## 🛠️ Local Setup

1.  **Install Dependencies**:
    ```bash
    npm install
    ```

2.  **Start Server**:
    ```bash
    npm start
    ```

3.  **Open Client**:
    Open `http://localhost:3000` in your browser.

## 🚀 Deployment (Render)

1.  Push this code to **GitHub**.
2.  Create a **New Web Service** on [Render](https://render.com/).
3.  Connect your GitHub repository.
4.  Current settings should be detected automatically:
    - **Runtime**: Node
    - **Build Command**: `npm install`
    - **Start Command**: `npm start`
5.  Deploy!

That's it. Since the backend serves the `public` folder, you don't need a separate Vercel deployment.
