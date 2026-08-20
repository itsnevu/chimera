const GifEncoder = require("gif-encoder-2");
const { writeFileSync } = require("fs");

class ChimeraGiffer {
  constructor(_canvas, _ctx, _fileName, _repeat, _quality, _delay) {
    this.canvas = _canvas;
    this.ctx = _ctx;
    this.fileName = _fileName;
    this.repeat = _repeat;
    this.quality = _quality;
    this.delay = _delay;
    this.initGifEncoder();
  }

  initGifEncoder = () => {
    this.gifEncoder = new GifEncoder(this.canvas.width, this.canvas.height);
    this.gifEncoder.setQuality(this.quality);
    this.gifEncoder.setRepeat(this.repeat);
    this.gifEncoder.setDelay(this.delay);
  };

  start = () => {
    this.gifEncoder.start();
  };

  add = () => {
    this.gifEncoder.addFrame(this.ctx);
  };

  stop = () => {
    this.gifEncoder.finish();
    const buffer = this.gifEncoder.out.getData();
    // Was writeFile with an empty callback: the error was discarded and the
    // success line printed before the write had settled, so an unwritable
    // path logged "Created gif at ..." and exited 0 with no file.
    try {
      writeFileSync(this.fileName, buffer);
      console.log(`Created gif at ${this.fileName}`);
    } catch (err) {
      console.error(`Could not write gif at ${this.fileName} — ${err.message}`);
      process.exitCode = 1;
    }
  };
}

module.exports = ChimeraGiffer;
