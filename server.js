const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID, timingSafeEqual } = require("node:crypto");

const root = __dirname;
const dataDirectory = path.join(root, "guest_uploads");
const filesDirectory = path.join(dataDirectory, "files");
const metadataFile = path.join(dataDirectory, "uploads.json");
const deletePin = process.env.DELETE_PIN || "12122026";
const pageRoutes = new Map([
    ["/", "/index.html"],
    ["/index.html", "/index.html"],
    ["/registry", "/reg.html"],
    ["/reg", "/reg.html"],
    ["/reg.html", "/reg.html"],
    ["/engagement", "/engage_photos.html"],
    ["/engage_photos.html", "/engage_photos.html"],
    ["/guest-photos", "/guest_photos.html"],
    ["/guest_photos.html", "/guest_photos.html"],
]);
const maxFileSize = 100 * 1024 * 1024;
const maxUploadsPerIpPerHour = 30;
const uploadAttempts = new Map();
const deleteAttempts = new Map();
const allowedStaticExtensions = new Set([".html", ".css", ".js", ".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const mimeTypes = {
    ".css": "text/css; charset=utf-8",
    ".gif": "image/gif",
    ".html": "text/html; charset=utf-8",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".webp": "image/webp",
};
const errorMessages = {
    400: "Invalid upload request.",
    404: "Not found.",
    413: "Files must be 100 MB or smaller.",
    415: "This file type is not supported.",
    429: "Too many requests from this connection. Please try again later.",
};

let metadataQueue = Promise.resolve();

function sendJson(response, status, payload) {
    response.writeHead(status, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify(payload));
}

function clientError(status) {
    const error = new Error(errorMessages[status] || "The upload could not be completed.");
    error.status = status;
    return error;
}

function decodeHeader(value, maximumLength) {
    if (!value) {
        return "";
    }
    try {
        return decodeURIComponent(value).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, maximumLength);
    } catch {
        throw clientError(400);
    }
}

function detectFileType(header) {
    if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
        return { type: "image", mimeType: "image/jpeg", extension: ".jpg" };
    }
    if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return { type: "image", mimeType: "image/png", extension: ".png" };
    }
    if (header.length >= 12 && header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP") {
        return { type: "image", mimeType: "image/webp", extension: ".webp" };
    }
    if (header.toString("ascii", 0, 6) === "GIF87a" || header.toString("ascii", 0, 6) === "GIF89a") {
        return { type: "image", mimeType: "image/gif", extension: ".gif" };
    }
    if (header.length >= 12 && header.toString("ascii", 4, 8) === "ftyp") {
        const quickTime = header.toString("ascii", 8, 12) === "qt  ";
        return {
            type: "video",
            mimeType: quickTime ? "video/quicktime" : "video/mp4",
            extension: quickTime ? ".mov" : ".mp4",
        };
    }
    if (header.length >= 4 && header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
        return { type: "video", mimeType: "video/webm", extension: ".webm" };
    }
    return null;
}

async function readUploads() {
    try {
        const data = await fs.readFile(metadataFile, "utf8");
        const uploads = JSON.parse(data);
        if (!Array.isArray(uploads)) {
            throw new Error("Upload index must be a JSON array.");
        }
        return uploads;
    } catch (error) {
        if (error.code === "ENOENT") {
            return [];
        }
        throw error;
    }
}

function appendUpload(upload) {
    const operation = updateUploads((uploads) => [upload, ...uploads]);
    return operation;
}

function updateUploads(update) {
    const operation = metadataQueue.then(async () => {
        const uploads = await readUploads();
        const updatedUploads = update(uploads);
        const temporaryFile = `${metadataFile}.${randomUUID()}.tmp`;
        await fs.writeFile(temporaryFile, JSON.stringify(updatedUploads, null, 2), { flag: "wx" });
        await fs.rename(temporaryFile, metadataFile);
        return updatedUploads;
    });
    metadataQueue = operation.catch((error) => {
        console.error("Could not save guest upload index:", error);
    });
    return operation;
}

function consumeDeleteAttempt(ipAddress) {
    const now = Date.now();
    const recent = (deleteAttempts.get(ipAddress) || []).filter((time) => now - time < 60 * 60 * 1000);
    if (recent.length >= 10) {
        deleteAttempts.set(ipAddress, recent);
        throw clientError(429);
    }
    recent.push(now);
    deleteAttempts.set(ipAddress, recent);
}

function isValidDeletePin(suppliedPin) {
    const expectedHash = createHash("sha256").update(deletePin).digest();
    const candidatePin = typeof suppliedPin === "string" ? suppliedPin : "";
    const suppliedHash = createHash("sha256").update(candidatePin).digest();
    return timingSafeEqual(expectedHash, suppliedHash);
}

async function deleteUpload(request, response, id) {
    const ipAddress = request.socket.remoteAddress || "unknown";
    consumeDeleteAttempt(ipAddress);
    if (!isValidDeletePin(request.headers["x-delete-pin"])) {
        sendJson(response, 401, { error: "Incorrect PIN. The photo was not deleted." });
        return;
    }

    let deletedUpload;
    await updateUploads((uploads) => {
        deletedUpload = uploads.find((upload) => upload.id === id);
        if (!deletedUpload) {
            throw clientError(404);
        }
        return uploads.filter((upload) => upload.id !== id);
    });

    const filePath = path.join(filesDirectory, `${deletedUpload.id}${deletedUpload.extension}`);
    try {
        await fs.unlink(filePath);
    } catch (error) {
        console.error(`Upload ${id} was removed from the index, but its file could not be deleted:`, error);
        sendJson(response, 500, { error: "The upload was removed from the gallery, but its file could not be cleaned up." });
        return;
    }

    sendJson(response, 200, { message: "Upload deleted." });
}

function consumeUploadLimit(ipAddress) {
    const now = Date.now();
    const recent = (uploadAttempts.get(ipAddress) || []).filter((time) => now - time < 60 * 60 * 1000);
    if (recent.length >= maxUploadsPerIpPerHour) {
        uploadAttempts.set(ipAddress, recent);
        throw clientError(429);
    }
    recent.push(now);
    uploadAttempts.set(ipAddress, recent);
}

async function serveUpload(response, id) {
    const uploads = await readUploads();
    const upload = uploads.find((entry) => entry.id === id);
    if (!upload) {
        sendJson(response, 404, { error: "Upload not found." });
        return;
    }

    const filePath = path.join(filesDirectory, `${upload.id}${upload.extension}`);
    const file = await fs.open(filePath, "r");
    const stat = await file.stat();
    response.writeHead(200, {
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Length": stat.size,
        "Content-Type": upload.mimeType,
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
    });
    file.createReadStream().pipe(response);
    response.on("close", () => file.close().catch((error) => console.error("Could not close upload:", error)));
}

async function serveStatic(request, response, pathname) {
    const requestedPath = pageRoutes.get(pathname) || pathname;
    const filePath = path.resolve(root, `.${requestedPath}`);
    if (!filePath.startsWith(`${root}${path.sep}`)) {
        sendJson(response, 404, { error: "Not found." });
        return;
    }

    const extension = path.extname(filePath).toLowerCase();
    if (!allowedStaticExtensions.has(extension)) {
        sendJson(response, 404, { error: "Not found." });
        return;
    }

    let file;
    try {
        file = await fs.open(filePath, "r");
    } catch (error) {
        if (error.code === "ENOENT" || error.code === "EISDIR") {
            sendJson(response, 404, { error: "Not found." });
            return;
        }
        throw error;
    }

    const stat = await file.stat();
    response.writeHead(200, {
        "Cache-Control": extension === ".html" || extension === ".js" ? "no-cache" : "public, max-age=3600",
        "Content-Length": stat.size,
        "Content-Type": mimeTypes[extension] || "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
    });
    if (request.method === "HEAD") {
        await file.close();
        response.end();
        return;
    }
    file.createReadStream().pipe(response);
    response.on("close", () => file.close().catch((error) => console.error("Could not close static file:", error)));
}

async function handleUpload(request, response) {
    consumeUploadLimit(request.socket.remoteAddress || "unknown");
    const declaredLength = Number(request.headers["content-length"]);
    if (!Number.isSafeInteger(declaredLength) || declaredLength <= 0) {
        throw clientError(400);
    }
    if (declaredLength > maxFileSize) {
        throw clientError(413);
    }

    const originalName = decodeHeader(request.headers["x-file-name"], 160) || "Guest upload";
    const guestName = decodeHeader(request.headers["x-guest-name"], 60);
    const caption = decodeHeader(request.headers["x-guest-caption"], 240);
    const id = randomUUID();
    const temporaryFile = path.join(filesDirectory, `${id}.uploading`);
    let fileHandle;
    let byteCount = 0;
    let header = Buffer.alloc(0);

    try {
        fileHandle = await fs.open(temporaryFile, "wx");
        for await (const chunk of request) {
            byteCount += chunk.length;
            if (byteCount > maxFileSize || byteCount > declaredLength) {
                throw clientError(413);
            }
            if (header.length < 32) {
                header = Buffer.concat([header, chunk.subarray(0, 32 - header.length)]);
            }
            let offset = 0;
            while (offset < chunk.length) {
                const { bytesWritten } = await fileHandle.write(chunk, offset, chunk.length - offset, null);
                if (bytesWritten === 0) {
                    throw new Error("Could not finish writing the uploaded file.");
                }
                offset += bytesWritten;
            }
        }
        if (byteCount !== declaredLength) {
            throw clientError(400);
        }
        const fileType = detectFileType(header);
        if (!fileType) {
            throw clientError(415);
        }

        const upload = {
            id,
            originalName,
            guestName,
            caption,
            type: fileType.type,
            mimeType: fileType.mimeType,
            extension: fileType.extension,
            uploadedAt: new Date().toISOString(),
            url: `/api/uploads/${id}`,
        };
        await fileHandle.close();
        fileHandle = null;
        await fs.rename(temporaryFile, path.join(filesDirectory, `${id}${fileType.extension}`));
        try {
            await appendUpload(upload);
        } catch (error) {
            await fs.unlink(path.join(filesDirectory, `${id}${fileType.extension}`));
            throw error;
        }
        sendJson(response, 201, { upload });
    } catch (error) {
        if (fileHandle) {
            await fileHandle.close();
        }
        await fs.unlink(temporaryFile).catch((unlinkError) => {
            if (unlinkError.code !== "ENOENT") {
                console.error("Could not remove incomplete upload:", unlinkError);
            }
        });
        throw error;
    }
}

async function handleRequest(request, response) {
    let url;
    try {
        url = new URL(request.url, "http://localhost");
    } catch {
        sendJson(response, 400, { error: "Invalid request URL." });
        return;
    }

    if (url.pathname === "/api/uploads" && request.method === "GET") {
        const filter = url.searchParams.get("type");
        if (filter && filter !== "image" && filter !== "video") {
            sendJson(response, 400, { error: "Filter must be image or video." });
            return;
        }
        const uploads = await readUploads();
        sendJson(response, 200, { uploads: filter ? uploads.filter((upload) => upload.type === filter) : uploads });
        return;
    }

    if (url.pathname === "/api/uploads" && request.method === "POST") {
        await handleUpload(request, response);
        return;
    }

    const uploadMatch = url.pathname.match(/^\/api\/uploads\/([0-9a-f-]{36})$/i);
    if (uploadMatch && request.method === "GET") {
        await serveUpload(response, uploadMatch[1]);
        return;
    }
    if (uploadMatch && request.method === "DELETE") {
        await deleteUpload(request, response, uploadMatch[1]);
        return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 405, { error: "Method not allowed." });
        return;
    }

    let pathname;
    try {
        pathname = decodeURIComponent(url.pathname);
    } catch {
        sendJson(response, 400, { error: "Invalid request path." });
        return;
    }
    if (pathname.length > 1 && pathname.endsWith("/")) {
        pathname = pathname.slice(0, -1);
    }
    await serveStatic(request, response, pathname);
}

async function main() {
    await fs.mkdir(filesDirectory, { recursive: true });
    const server = http.createServer((request, response) => {
        handleRequest(request, response).catch((error) => {
            if (response.headersSent || response.destroyed) {
                console.error("Request failed after response started:", error);
                response.destroy();
                return;
            }
            if (error.status) {
                sendJson(response, error.status, { error: error.message });
                return;
            }
            console.error("Request failed:", error);
            sendJson(response, 500, { error: "The server could not complete the request." });
        });
    });
    const port = Number(process.env.PORT) || 3000;
    server.listen(port, "0.0.0.0", () => {
        console.log(`Wedding photo gallery listening on port ${port}`);
    });
}

main().catch((error) => {
    console.error("Could not start the wedding photo gallery:", error);
    process.exitCode = 1;
});