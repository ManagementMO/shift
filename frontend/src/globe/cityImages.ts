interface CityImage {
  src: string
  source: string
  author: string
  license: string
  licenseUrl: string
}

export const CITY_IMAGES: Record<string, CityImage> = {
  toronto: {
    src: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/8/8b/Toronto_Skyline_from_Snake_Island%2C_September_11_2026_%2801%29.jpg/250px-Toronto_Skyline_from_Snake_Island%2C_September_11_2026_%2801%29.jpg',
    source: 'https://commons.wikimedia.org/wiki/File:Toronto_Skyline_from_Snake_Island,_September_11_2026_(01).jpg',
    author: 'Dillan Payne', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0',
  },
  'new-york': {
    src: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/7/7a/View_of_Empire_State_Building_from_Rockefeller_Center_New_York_City_dllu_%28cropped%29.jpg/250px-View_of_Empire_State_Building_from_Rockefeller_Center_New_York_City_dllu_%28cropped%29.jpg',
    source: 'https://commons.wikimedia.org/wiki/File:View_of_Empire_State_Building_from_Rockefeller_Center_New_York_City_dllu_(cropped).jpg',
    author: 'Dllu', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0',
  },
  london: {
    src: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/6/67/London_Skyline_%28125508655%29.jpeg/250px-London_Skyline_%28125508655%29.jpeg',
    source: 'https://commons.wikimedia.org/wiki/File:London_Skyline_(125508655).jpeg',
    author: 'Ilya Grigorik', license: 'CC BY-SA 3.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0',
  },
  tokyo: {
    src: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/b/b2/Skyscrapers_of_Shinjuku_2009_January.jpg/250px-Skyscrapers_of_Shinjuku_2009_January.jpg',
    source: 'https://commons.wikimedia.org/wiki/File:Skyscrapers_of_Shinjuku_2009_January.jpg',
    author: 'Morio', license: 'CC BY-SA 3.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0',
  },
  singapore: {
    src: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/c/c7/Marina_Bay_Sands_%28I%29.jpg/250px-Marina_Bay_Sands_%28I%29.jpg',
    source: 'https://commons.wikimedia.org/wiki/File:Marina_Bay_Sands_(I).jpg',
    author: 'Supanut Arunoprayote', license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0',
  },
  dubai: {
    src: 'https://thumb.wikimedia.org/wikipedia/en/thumb/c/c7/Burj_Khalifa_2021.jpg/250px-Burj_Khalifa_2021.jpg',
    source: 'https://en.wikipedia.org/wiki/File:Burj_Khalifa_2021.jpg',
    author: 'Francisco Anzola', license: 'CC BY 2.0', licenseUrl: 'https://creativecommons.org/licenses/by/2.0/',
  },
  'sao-paulo': {
    src: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/7/73/Marginal_Pinheiros_e_Jockey_Club.jpg/250px-Marginal_Pinheiros_e_Jockey_Club.jpg',
    source: 'https://commons.wikimedia.org/wiki/File:Marginal_Pinheiros_e_Jockey_Club.jpg',
    author: 'Agent010', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0',
  },
  sydney: {
    src: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/5/53/Sydney_Opera_House_and_Harbour_Bridge_Dusk_%282%29_2019-06-21.jpg/250px-Sydney_Opera_House_and_Harbour_Bridge_Dusk_%282%29_2019-06-21.jpg',
    source: 'https://commons.wikimedia.org/wiki/File:Sydney_Opera_House_and_Harbour_Bridge_Dusk_(2)_2019-06-21.jpg',
    author: 'Benh LIEU SONG', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0',
  },
}
