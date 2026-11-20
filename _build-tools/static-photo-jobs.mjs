export const STATIC_PHOTO_JOBS = Object.freeze([
  {
    source: 'editorial/crystal-chandelier-hero-enhanced-v1.webp',
    outputs: [
      ['editorial/crystal-chandelier-hero-enhanced-v2-640.webp', 640],
      ['editorial/crystal-chandelier-hero-enhanced-v2-960.webp', 960],
      ['editorial/crystal-chandelier-hero-enhanced-v2.webp', 1448]
    ]
  },
  {
    source: 'editorial/eames-orange-chairs-enhanced-v1.webp',
    outputs: [
      ['editorial/eames-orange-chairs-enhanced-v2-640.webp', 640],
      ['editorial/eames-orange-chairs-enhanced-v2-960.webp', 960],
      ['editorial/eames-orange-chairs-enhanced-v2.webp', 1254]
    ]
  },
  {
    source: 'editorial/hidden-gem-murano-chandelier.jpg',
    outputs: [
      ['editorial/murano-overview-384.webp', 384],
      ['editorial/murano-overview-640.webp', 640]
    ]
  },
  {
    source: '../_build-tools/photo-sources/murano-fluted-cup.jpg',
    outputs: [
      ['editorial/murano-fluted-cup-320.webp', 320],
      ['editorial/murano-fluted-cup-640.webp', 640]
    ]
  },
  {
    source: '../_build-tools/photo-sources/murano-glass-branches.jpg',
    outputs: [
      ['editorial/murano-glass-branches-320.webp', 320],
      ['editorial/murano-glass-branches-640.webp', 640]
    ]
  },
  {
    source: '../_build-tools/photo-sources/smiroldo-drummer.jpg',
    outputs: [
      ['editorial/smiroldo-drummer-480.webp', 480],
      ['editorial/smiroldo-drummer-789.webp', 789]
    ]
  },
  {
    source: '../_build-tools/photo-sources/lane-park-chest.jpg',
    outputs: [
      ['editorial/lane-park-chest-480.webp', 480],
      ['editorial/lane-park-chest-798.webp', 798]
    ]
  },
  {
    source: '../_build-tools/photo-sources/showroom-native.png',
    outputs: [
      ['editorial/gallery-showroom-768.webp', 768],
      ['editorial/gallery-showroom-1135.webp', 1135]
    ]
  }
].map(job => Object.freeze({
  source: job.source,
  outputs: Object.freeze(job.outputs.map(output => Object.freeze(output)))
})));
