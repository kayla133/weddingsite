const gallery = document.querySelector(".gallery");
const lightbox = document.querySelector("#engagement-lightbox");
const lightboxImage = document.querySelector("#lightbox-image");
const lightboxCounter = document.querySelector("#lightbox-counter");
const previousButton = document.querySelector("#lightbox-previous");
const nextButton = document.querySelector("#lightbox-next");
const closeButton = document.querySelector("#lightbox-close");
const photoLinks = Array.from(gallery.querySelectorAll("img"), (image) => {
    const link = document.createElement("a");
    link.href = image.src;
    link.setAttribute("aria-label", `Open ${image.alt}`);
    image.replaceWith(link);
    link.append(image);
    return link;
});

let currentPhoto = 0;

function showPhoto(index) {
    currentPhoto = (index + photoLinks.length) % photoLinks.length;
    const link = photoLinks[currentPhoto];
    const thumbnail = link.querySelector("img");

    lightboxImage.src = link.href;
    lightboxImage.alt = thumbnail.alt;
    lightboxCounter.textContent = `${currentPhoto + 1} of ${photoLinks.length}`;
}

function openLightbox(index) {
    showPhoto(index);
    lightbox.showModal();
}

gallery.addEventListener("click", (event) => {
    const link = event.target.closest("a");
    if (!link || !gallery.contains(link)) {
        return;
    }

    event.preventDefault();
    openLightbox(photoLinks.indexOf(link));
});

previousButton.addEventListener("click", () => showPhoto(currentPhoto - 1));
nextButton.addEventListener("click", () => showPhoto(currentPhoto + 1));
closeButton.addEventListener("click", () => lightbox.close());

lightbox.addEventListener("click", (event) => {
    if (event.target === lightbox) {
        lightbox.close();
    }
});

lightbox.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") {
        event.preventDefault();
        showPhoto(currentPhoto - 1);
    } else if (event.key === "ArrowRight") {
        event.preventDefault();
        showPhoto(currentPhoto + 1);
    } else if (event.key === "Escape") {
        event.preventDefault();
        lightbox.close();
    }
});
