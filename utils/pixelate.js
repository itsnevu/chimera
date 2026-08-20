const fs = require("fs");
const path = require("path");
const { createCanvas, loadImage } = require("canvas");
const basePath = process.cwd();
const buildDir = `${basePath}/build/pixel_images`;
const inputDir = `${basePath}/build/images`;
const { format, pixelFormat } = require(`${basePath}/src/config.js`);
const console = require("console");
// Sized per image in draw(); format is only the fallback for an empty run.
const canvas = createCanvas(format.width, format.height);
const ctx = canvas.getContext("2d");

const buildSetup = () => {
  if (fs.existsSync(buildDir)) {
    fs.rmSync(buildDir, { recursive: true });
  }
  fs.mkdirSync(buildDir, { recursive: true });
};

const getImages = (_dir) => {
  try {
    return fs
      .readdirSync(_dir)
      .filter((item) => {
        let extension = path.extname(`${_dir}${item}`);
        if (extension == ".png" || extension == ".jpg") {
          return item;
        }
      })
      .map((i) => {
        return {
          filename: i,
          path: `${_dir}/${i}`,
        };
      });
  } catch {
    return null;
  }
};

const loadImgData = async (_imgObject) => {
  try {
    const image = await loadImage(`${_imgObject.path}`);
    return {
      imgObject: _imgObject,
      loadedImage: image,
    };
  } catch (error) {
    console.error("Error loading image:", error);
  }
};

const draw = (_imgObject) => {
  const img = _imgObject.loadedImage;

  // Match the source, not src/config.js. The canvas was fixed at format.width,
  // so 1024px AI renders were silently downscaled to 512.
  if (canvas.width !== img.width || canvas.height !== img.height) {
    canvas.width = img.width;
    canvas.height = img.height;
  }
  // The canvas is shared across every image and was never cleared, so any
  // transparency let the previous image show through — a transparent frame
  // after a magenta one came out solid magenta.
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const size = pixelFormat.ratio;
  // Round: canvas.width * ratio is only an integer by coincidence (500 * 2/128
  // is 7.8125), and a fractional source rect blurs the "pixels".
  const w = Math.max(1, Math.round(canvas.width * size));
  const h = Math.max(1, Math.round(canvas.height * size));

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, w, h);
  ctx.drawImage(canvas, 0, 0, w, h, 0, 0, canvas.width, canvas.height);
};

const saveImage = (_loadedImageObject) => {
  fs.writeFileSync(
    `${buildDir}/${_loadedImageObject.imgObject.filename}`,
    canvas.toBuffer("image/png")
  );
};

const startCreating = async () => {
  const images = getImages(inputDir);
  if (images == null) {
    console.log("Please generate collection first.");
    return;
  }
  let loadedImageObjects = [];
  images.forEach((imgObject) => {
    loadedImageObjects.push(loadImgData(imgObject));
  });
  await Promise.all(loadedImageObjects).then((loadedImageObjectArray) => {
    loadedImageObjectArray.forEach((loadedImageObject) => {
      draw(loadedImageObject);
      saveImage(loadedImageObject);
      console.log(`Pixelated image: ${loadedImageObject.imgObject.filename}`);
    });
  });
};

buildSetup();
startCreating();
