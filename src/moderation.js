const FORBIDDEN = [
  // ===== 色情 · 中文直白 =====
  '色情', '黄色', '淫', '妓', '嫖', '娼',
  '裸体', '裸照', '裸露', '全裸', '半裸', '露点', '走光', '漏点',
  '性交', '性爱', '性行为', '性欲', '做爱', '交配', '啪啪', '开房',
  '阴茎', '阴道', '阴部', '阴唇', '阴毛', '阴蒂', '阴茎勃起',
  '乳头', '乳房', '乳沟', '胸部', '奶子', '巨乳', '爆乳', '露胸',
  '屁股', '臀部', '翘臀', '蜜桃臀', '肉棒', '鸡巴', '鸡吧',
  '射精', '精液', '口交', '肛交', '口爆', '内射', '颜射',
  '调教', '轮奸', '强奸', '强暴', '猥亵', '性侵', '迷奸',
  '小穴', '骚穴', '肉穴', '抽插', '插入', '打桩', '后入',
  '自慰', '手淫', '飞机', '撸管', '高潮', '爽', '呻吟',
  '无码', '步兵', '骑兵', 'AV', '成人', '三级', '18禁', '十八禁',
  '情趣', '情色', '肉', '肉文', '福利', '福利姬', '援交', '绿帽',
  'NTR', '牛头人', '绿帽癖', '原味', '丝袜诱惑', '比基尼诱惑',
  '露出', '挑逗', '勾引', '诱惑', '媚姿', '媚态', '娇喘',
  '透视装', '湿身', '走光', '偷拍', '开腿', '张腿', '分腿',
  '咪咪', '波霸', '隐私部位', '私处', '私密部位',

  // ===== 色情 · 英文 =====
  'nude', 'naked', 'topless', 'bottomless',
  'porn', 'pornograph', 'xxx', 'nsfw',
  'sex ', 'sexy', 'sexual', 'erotic', 'erotica', 'kinky',
  'penis', 'vagina', 'vulva', 'clitoris',
  'boob', 'boobs', 'breast', 'breasts', 'nipple', 'nipples',
  'pussy', 'cock ', 'dick ', 'cum', 'cumshot', 'semen',
  'blowjob', 'handjob', 'anal', 'orgasm', 'masturbat',
  'hentai', 'ecchi', 'fetish', 'bdsm', 'bondage',
  'rape', 'raped', 'molest',
  'lingerie', 'thong', 'g-string', 'upskirt',
  'camel toe', 'cameltoe', 'cleavage',

  // ===== 未成年相关(零容忍) =====
  '萝莉', '幼女', '幼童', '稚嫩', '童颜巨乳',
  '小学生', '初中生', '中学生', '儿童色情', '童色', '未成年',
  '10岁', '11岁', '12岁', '13岁', '14岁', '15岁', '16岁', '17岁',
  'lolicon', 'shotacon', 'loli ', ' loli', 'shota',
  'underage', 'minor sex', 'child porn', 'preteen', 'jailbait',

  // ===== 血腥暴力 =====
  '血腥', '斩首', '砍头', '虐杀', '肢解', '剁碎', '凌迟', '活埋', '焚尸',
  '酷刑', '虐待', '自残', '自杀', '割喉', '爆头', '屠杀', '处决', '枪决',
  '砍人', '杀人', '杀害', '碎尸', '尸体', '死尸', '内脏', '血泊', '血浆',
  '断肢', '断头', '开膛', '剖腹', '剖腹产血腥', '枪击', '挖眼', '拔牙酷刑',
  'gore', 'gory', 'decapitat', 'behead', 'torture', 'dismember', 'mutilat',
  'suicide', 'self-harm', 'self harm', 'massacre', 'slaughter',
  'bloodbath', 'bloody corpse', 'execute ', 'execution',

  // ===== 违法 · 毒品 =====
  '毒品', '海洛因', '冰毒', '大麻', '摇头丸', '可卡因', '吸毒', '制毒', '贩毒',
  '鸦片', '罂粟', '麻黄素', '氯胺酮', 'K粉', '神仙水', '笑气',
  'heroin', 'cocaine', 'fentanyl', 'methamphetamine', 'crystal meth',

  // ===== 违法 · 恐怖 / 武器 =====
  '恐怖袭击', '恐怖分子', '炸弹制作', '人体炸弹', '自爆', '制造枪支', '走私军火',
  '私藏枪支', 'AK47', '土制炸弹', 'TNT', '硝铵炸药', '雷管',
  'ISIS', '伊斯兰国', '基地组织', '本拉登',
  'bomb making', 'how to make a bomb', 'build a bomb', 'terrorist attack',

  // ===== 违法 · 政治极端 =====
  '纳粹', '希特勒', '法西斯', '种族灭绝', '种族清洗', '排华',
  'nazi', 'swastika', 'hitler', 'genocide',

  // ===== 违法 · 其他 =====
  '人口贩卖', '拐卖儿童', '拐卖妇女', '偷渡', '假钞', '假证', '假身份证',
]

export function checkForbidden(text) {
  if (!text) return false
  const normalized = text.toLowerCase()
  for (const w of FORBIDDEN) {
    if (normalized.includes(w.toLowerCase())) return true
  }
  return false
}
