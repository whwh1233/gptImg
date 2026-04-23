const FORBIDDEN = {
  sexual: [
    '色情', '黄色', '裸体', '裸照', '裸露', '全裸', '半裸',
    '性交', '性爱', '性行为', '做爱', '交配', '啪啪啪',
    '阴茎', '阴道', '阴部', '乳头', '乳房', '胸部', '奶子', '屁股', '臀部', '肉棒',
    '射精', '口交', '肛交', '口爆', '调教', '轮奸', '强奸', '强暴', '猥亵',
    'NTR', '绿帽', '原味', '自慰', '手淫', '淫', '妓',
    '无码', '福利姬', '援交',
    'nude', 'naked', 'porn', 'pornograph', 'sex', 'sexual', 'erotic', 'erotica',
    'nsfw', 'penis', 'vagina', 'boob', 'breast', 'nipple',
    'pussy', 'cock', 'dick', 'cum', 'blowjob', 'handjob',
    'anal', 'orgasm', 'masturbat', 'hentai', 'ecchi', 'fetish',
    'bdsm', 'bondage', 'rape',
  ],
  minors: [
    '萝莉', '幼女', '幼童', '儿童色情', '童色', '未成年裸',
    'lolicon', 'shotacon', 'loli', 'shota', 'underage',
    'child porn', 'cp (child', 'minor sex',
  ],
  violence: [
    '血腥', '斩首', '砍头', '虐杀', '肢解', '剁碎', '凌迟', '活埋', '焚尸',
    '酷刑', '虐待', '自残', '自杀', '割喉', '爆头', '屠杀', '处决',
    'gore', 'decapitat', 'behead', 'torture', 'dismember', 'mutilat',
    'suicide', 'self-harm', 'self harm', 'massacre', 'execute ',
  ],
  illegal: [
    '毒品', '海洛因', '冰毒', '大麻', '摇头丸', '可卡因', '吸毒', '制毒',
    '恐怖袭击', '恐怖分子', '炸弹制作', '人体炸弹', '制造枪支', '走私军火',
    '纳粹', '希特勒', '法西斯',
    'heroin', 'cocaine', 'fentanyl', 'methamphetamine',
    'bomb making', 'how to make a bomb', 'build a bomb', 'terrorist attack',
    'nazi', 'swastika',
  ],
}

const CATEGORY_LABEL = {
  sexual: '色情',
  minors: '未成年相关',
  violence: '血腥暴力',
  illegal: '违法内容',
}

export function checkForbidden(text) {
  if (!text) return null
  const normalized = text.toLowerCase()
  for (const [category, words] of Object.entries(FORBIDDEN)) {
    for (const w of words) {
      if (normalized.includes(w.toLowerCase())) {
        return { category, label: CATEGORY_LABEL[category], keyword: w }
      }
    }
  }
  return null
}
