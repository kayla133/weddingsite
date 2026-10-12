const form = document.querySelector("#upload-form");
const fileInput = document.querySelector("#guest-files");
const chooseFilesButton = document.querySelector("#choose-files");
const uploadStatus = document.querySelector("#upload-status");
const galleryStatus = document.querySelector("#gallery-status");
const gallery = document.querySelector("#guest-gallery");
const filters = document.querySelectorAll("[data-filter]");

let currentFilter = "all";

form.addEventListener("submit", (event) => event.preventDefault());

function uploadFile(file, name, caption) {
    return new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open("POST", "/api/uploads");
        request.setRequestHeader("Content-Type", "application/octet-stream");
        request.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
        request.setRequestHeader("X-Guest-Name", encodeURIComponent(name));
        request.setRequestHeader("X-Guest-Caption", encodeURIComponent(caption));

        request.upload.addEventListener("progress", (event) => {
            if (event.lengthComputable) {
                const percent = Math.round((event.loaded / event.total) * 100);
                uploadStatus.textContent = `Uploading ${file.name}: ${percent}%`;
            }
        });

        request.addEventListener("load", () => {
            let response;
            try {
                response = JSON.parse(request.responseText);
            } catch {
                reject(new Error("The server returned an invalid response."));
                return;
            }

            if (request.status >= 200 && request.status < 300) {
                resolve(response.upload);
            } else {
                reject(new Error(response.error || `Upload failed (${request.status}).`));
            }
        });

        request.addEventListener("error", () => reject(new Error("Network error while uploading.")));
        request.addEventListener("abort", () => reject(new Error("Upload was cancelled.")));
        request.send(file);
    });
}

function formatDate(value) {
    return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(new Date(value));
}

function createGalleryItem(upload) {
    const item = document.createElement("li");
    item.dataset.type = upload.type;

    const link = document.createElement("a");
    link.href = upload.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", `Open ${upload.originalName}`);

    if (upload.type === "image") {
        const image = document.createElement("img");
        image.src = upload.url;
        image.alt = upload.caption || upload.originalName;
        image.loading = "lazy";
        image.decoding = "async";
        link.append(image);
    } else {
        const video = document.createElement("video");
        video.src = upload.url;
        video.controls = true;
        video.preload = "metadata";
        video.setAttribute("aria-label", upload.caption || upload.originalName);
        item.append(video);
    }

    if (upload.type === "image") {
        item.append(link);
    } else {
        link.textContent = "Open video in a new tab";
        link.className = "video-open-link";
        item.append(link);
    }

    const details = document.createElement("div");
    details.className = "gallery-item-caption";
    const caption = document.createElement("p");
    caption.textContent = upload.caption || upload.originalName;
    const byline = document.createElement("small");
    byline.textContent = `${upload.guestName ? `${upload.guestName} · ` : ""}${formatDate(upload.uploadedAt)}`;
    const deleteButton = document.createElement("button");
    deleteButton.className = "delete-upload-button";
    deleteButton.type = "button";
    deleteButton.textContent = "Delete";
    deleteButton.setAttribute("aria-label", `Delete ${upload.originalName}`);
    deleteButton.addEventListener("click", async () => {
        if (!window.confirm("Delete this guest upload? This cannot be undone.")) {
            return;
        }

        const pin = window.prompt("Enter the deletion PIN to remove this upload:");
        if (pin === null) {
            return;
        }

        deleteButton.disabled = true;
        try {
            const response = await fetch(upload.url, {
                method: "DELETE",
                headers: { "X-Delete-Pin": pin },
            });
            const result = await response.json();
            if (!response.ok) {
                throw new Error(result.error || "Could not delete the upload.");
            }
            uploadStatus.textContent = "Upload deleted.";
            await loadGallery();
        } catch (error) {
            uploadStatus.textContent = error.message;
            deleteButton.disabled = false;
        }
    });
    details.append(caption, byline, deleteButton);
    item.append(details);

    return item;
}

function applyFilter() {
    for (const item of gallery.children) {
        item.hidden = currentFilter !== "all" && item.dataset.type !== currentFilter;
    }
}

async function loadGallery() {
    galleryStatus.textContent = "Loading guest uploads...";
    try {
        const response = await fetch("/api/uploads");
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || "Could not load the gallery.");
        }

        gallery.replaceChildren(...result.uploads.map(createGalleryItem));
        applyFilter();
        galleryStatus.textContent = result.uploads.length
            ? `${result.uploads.length} ${result.uploads.length === 1 ? "upload" : "uploads"} shared by guests`
            : "No guest uploads yet. Be the first to share a memory!";
    } catch (error) {
        galleryStatus.textContent = `Could not load guest uploads: ${error.message}`;
    }
}

chooseFilesButton.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", async () => {
    const files = Array.from(fileInput.files || []);
    if (!files.length) {
        return;
    }

    chooseFilesButton.disabled = true;
    const guestName = form.elements.guestName.value.trim();
    const caption = form.elements.caption.value.trim();
    let uploaded = 0;
    const errors = [];

    for (const file of files) {
        try {
            await uploadFile(file, guestName, caption);
            uploaded += 1;
        } catch (error) {
            errors.push(`${file.name}: ${error.message}`);
        }
    }

    fileInput.value = "";
    chooseFilesButton.disabled = false;

    if (errors.length) {
        uploadStatus.textContent = `${uploaded} uploaded. ${errors.join(" ")}`;
    } else {
        uploadStatus.textContent = `${uploaded} ${uploaded === 1 ? "file" : "files"} uploaded. Thank you for sharing!`;
    }
    await loadGallery();
});

for (const button of filters) {
    button.addEventListener("click", () => {
        currentFilter = button.dataset.filter;
        for (const filter of filters) {
            const active = filter === button;
            filter.classList.toggle("is-active", active);
            filter.setAttribute("aria-pressed", String(active));
        }
        applyFilter();
    });
}

loadGallery();
