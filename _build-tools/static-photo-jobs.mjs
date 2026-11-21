export const STATIC_PHOTO_JOBS = Object.freeze([
  {
    source: '../_build-tools/photo-sources/crystal-archive-master.png',
    outputs: [
      ['editorial/crystal-chandelier-hero-enhanced-v3-640.webp', 640],
      ['editorial/crystal-chandelier-hero-enhanced-v3-960.webp', 960],
      ['editorial/crystal-chandelier-prisms.webp', 1448]
    ]
  },
  {
    source: '../_build-tools/photo-sources/chairs-and-cat-archive-master.png',
    outputs: [
      ['editorial/eames-orange-chairs-enhanced-v3-640.webp', 640],
      ['editorial/eames-orange-chairs-enhanced-v3-960.webp', 960],
      ['editorial/orange-chairs-and-gallery-cat.webp', 1254]
    ]
  },
  {
    source: '../_build-tools/photo-sources/chairs-and-cat-archive-master.png',
    crop: { left: 16, top: 185, width: 900, height: 900 },
    outputs: [['editorial/cat-meets-eames.webp', 900]]
  },
  {
    source: '../_build-tools/photo-sources/murano-registered-master.png',
    outputs: [
      ['editorial/murano-overview-v2-384.webp', 384],
      ['editorial/murano-overview-v2-640.webp', 640],
      ['editorial/murano-overview-v2-1280.webp', 1280]
    ]
  },
  {
    source: '../_build-tools/photo-sources/murano-fluted-cup.jpg',
    outputs: [
      ['editorial/murano-fluted-cup-v2-320.webp', 320],
      ['editorial/murano-fluted-cup-v2-640.webp', 640]
    ]
  },
  {
    source: '../_build-tools/photo-sources/murano-glass-branches.jpg',
    outputs: [
      ['editorial/murano-glass-branches-v2-320.webp', 320],
      ['editorial/murano-glass-branches-v2-640.webp', 640]
    ]
  },
  {
    source: '../_build-tools/photo-sources/smiroldo-drummer.jpg',
    outputs: [
      ['editorial/smiroldo-drummer-v2-480.webp', 480],
      ['editorial/smiroldo-drummer-v2-789.webp', 789]
    ]
  },
  {
    source: '../_build-tools/photo-sources/lane-park-chest.jpg',
    outputs: [
      ['editorial/lane-park-chest-v2-480.webp', 480],
      ['editorial/lane-park-chest-v2-798.webp', 798]
    ]
  },
  {
    source: '../_build-tools/photo-sources/showroom-native.png',
    outputs: [
      ['editorial/gallery-showroom-v2-768.webp', 768],
      ['editorial/gallery-showroom-v2-1135.webp', 1135]
    ]
  }
].map(job => Object.freeze({
  source: job.source,
  crop: job.crop && Object.freeze(job.crop),
  outputs: Object.freeze(job.outputs.map(output => Object.freeze(output)))
})));
