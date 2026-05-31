'use strict';

const { searchExtraFlix } = require('./extraflix');
const { searchUHDRodeo, getUHDRodeoLinks } = require('./uhdrodeo');
const { searchMoviesDrives, getMoviesDrivesLinks } = require('./moviesdrives');
const { getDownloadLinks } = require('./downloadLinks');

module.exports = {
  searchExtraFlix,
  searchUHDRodeo,
  getUHDRodeoLinks,
  searchMoviesDrives,
  getMoviesDrivesLinks,
  getDownloadLinks,
};
