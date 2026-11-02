// AlcorMap offline place list. Original compact dataset compiled for AlcorMap: national capitals,
// US states, US state capitals and major cities, and major world cities. Coordinates are rounded
// approximate city centres (states: approximate geographic centres) in decimal degrees.
// Loaded lazily on the first search; it never makes a network request of its own.
//
// COUNTRIES: "CC=Name;Alias;Alias" separated by "|".
// PLACES: one place per line, "Name|kind|CC|region|lat|lng[|zoom]".
//   kind: C national capital, S US state, R UK nation, T town or city. region: US state code for US places,
//   or ENG, SCT, WLS, NIR (see ALCORMAP_GB_NATIONS) for places in the United Kingdom.

export const ALCORMAP_PLACES_VERSION = 1;

export const ALCORMAP_COUNTRIES =
  'AD=Andorra|AE=United Arab Emirates;UAE;Emirates|AF=Afghanistan|AG=Antigua and Barbuda|AL=Albania|AM=Armenia|AO=Angola|AR=Argentina|AT=Austria|AU=Australia|AZ=Azerbaijan|BA=Bosnia and Herzegovina;Bosnia|BB=Barbados|BD=Bangladesh|BE=Belgium|BF=Burkina Faso|BG=Bulgaria|BH=Bahrain|BI=Burundi|BJ=Benin|BN=Brunei|BO=Bolivia|BR=Brazil;Brasil|BS=Bahamas|BT=Bhutan|BW=Botswana|BY=Belarus|BZ=Belize|CA=Canada|CD=DR Congo;Democratic Republic of the Congo;Congo-Kinshasa|CF=Central African Republic|CG=Republic of the Congo;Congo-Brazzaville|CH=Switzerland|CI=Côte d’Ivoire;Ivory Coast|CL=Chile|CM=Cameroon|CN=China|CO=Colombia|CR=Costa Rica|CU=Cuba|CV=Cabo Verde;Cape Verde|CY=Cyprus|CZ=Czechia;Czech Republic|DE=Germany;Deutschland|DJ=Djibouti|DK=Denmark|DM=Dominica|DO=Dominican Republic|DZ=Algeria|EC=Ecuador|EE=Estonia|EG=Egypt|ER=Eritrea|ES=Spain;España|ET=Ethiopia|FI=Finland|FJ=Fiji|FM=Micronesia|FR=France|GA=Gabon|GB=United Kingdom;UK;Britain|GD=Grenada|GE=Georgia|GH=Ghana|GL=Greenland|GM=Gambia|GN=Guinea|GQ=Equatorial Guinea|GR=Greece|GT=Guatemala|GW=Guinea-Bissau|GY=Guyana|HK=Hong Kong|HN=Honduras|HR=Croatia|HT=Haiti|HU=Hungary|ID=Indonesia|IE=Ireland|IL=Israel|IN=India|IQ=Iraq|IR=Iran|IS=Iceland|IT=Italy;Italia|JM=Jamaica|JO=Jordan|JP=Japan|KE=Kenya|KG=Kyrgyzstan|KH=Cambodia|KI=Kiribati|KM=Comoros|KN=Saint Kitts and Nevis|KP=North Korea|KR=South Korea;Korea|KW=Kuwait|KZ=Kazakhstan|LA=Laos|LB=Lebanon|LC=Saint Lucia|LI=Liechtenstein|LK=Sri Lanka|LR=Liberia|LS=Lesotho|LT=Lithuania|LU=Luxembourg|LV=Latvia|LY=Libya|MA=Morocco|MC=Monaco|MD=Moldova|ME=Montenegro|MG=Madagascar|MH=Marshall Islands|MK=North Macedonia|ML=Mali|MM=Myanmar;Burma|MN=Mongolia|MO=Macau|MR=Mauritania|MT=Malta|MU=Mauritius|MV=Maldives|MW=Malawi|MX=Mexico;México|MY=Malaysia|MZ=Mozambique|NA=Namibia|NC=New Caledonia|NE=Niger|NG=Nigeria|NI=Nicaragua|NL=Netherlands;Holland|NO=Norway|NP=Nepal|NR=Nauru|NZ=New Zealand;Aotearoa|OM=Oman|PA=Panama|PE=Peru|PF=French Polynesia;Tahiti|PG=Papua New Guinea|PH=Philippines|PK=Pakistan|PL=Poland|PR=Puerto Rico|PS=Palestine|PT=Portugal|PW=Palau|PY=Paraguay|QA=Qatar|RO=Romania|RS=Serbia|RU=Russia|RW=Rwanda|SA=Saudi Arabia|SB=Solomon Islands|SC=Seychelles|SD=Sudan|SE=Sweden|SG=Singapore|SI=Slovenia|SK=Slovakia|SL=Sierra Leone|SM=San Marino|SN=Senegal|SO=Somalia|SR=Suriname|SS=South Sudan|ST=São Tomé and Príncipe|SV=El Salvador|SY=Syria|SZ=Eswatini;Swaziland|TD=Chad|TG=Togo|TH=Thailand|TJ=Tajikistan|TL=Timor-Leste;East Timor|TM=Turkmenistan|TN=Tunisia|TO=Tonga|TR=Türkiye;Turkey|TT=Trinidad and Tobago|TV=Tuvalu|TW=Taiwan|TZ=Tanzania|UA=Ukraine|UG=Uganda|US=United States;USA;America|UY=Uruguay|UZ=Uzbekistan|VA=Vatican City;Holy See|VC=Saint Vincent and the Grenadines|VE=Venezuela|VN=Vietnam;Viet Nam|VU=Vanuatu|WS=Samoa|XK=Kosovo|YE=Yemen|ZA=South Africa|ZM=Zambia|ZW=Zimbabwe';

export const ALCORMAP_US_STATES =
  'AL=Alabama|AK=Alaska|AZ=Arizona|AR=Arkansas|CA=California|CO=Colorado|CT=Connecticut|DE=Delaware|DC=District of Columbia|FL=Florida|GA=Georgia|HI=Hawaii|ID=Idaho|IL=Illinois|IN=Indiana|IA=Iowa|KS=Kansas|KY=Kentucky|LA=Louisiana|ME=Maine|MD=Maryland|MA=Massachusetts|MI=Michigan|MN=Minnesota|MS=Mississippi|MO=Missouri|MT=Montana|NE=Nebraska|NV=Nevada|NH=New Hampshire|NJ=New Jersey|NM=New Mexico|NY=New York|NC=North Carolina|ND=North Dakota|OH=Ohio|OK=Oklahoma|OR=Oregon|PA=Pennsylvania|RI=Rhode Island|SC=South Carolina|SD=South Dakota|TN=Tennessee|TX=Texas|UT=Utah|VT=Vermont|VA=Virginia|WA=Washington|WV=West Virginia|WI=Wisconsin|WY=Wyoming';

export const ALCORMAP_GB_NATIONS = 'ENG=England|SCT=Scotland|WLS=Wales|NIR=Northern Ireland';

export const ALCORMAP_PLACES = `Kabul|C|AF||34.53|69.17
Tirana|C|AL||41.33|19.82
Algiers|C|DZ||36.75|3.06
Andorra la Vella|C|AD||42.51|1.52
Luanda|C|AO||-8.84|13.23
Saint John’s|C|AG||17.12|-61.85
Buenos Aires|C|AR||-34.60|-58.38
Yerevan|C|AM||40.18|44.51
Canberra|C|AU||-35.28|149.13
Vienna|C|AT||48.21|16.37
Baku|C|AZ||40.41|49.87
Nassau|C|BS||25.05|-77.35
Manama|C|BH||26.23|50.59
Dhaka|C|BD||23.81|90.41
Bridgetown|C|BB||13.10|-59.62
Minsk|C|BY||53.90|27.57
Brussels|C|BE||50.85|4.35
Belmopan|C|BZ||17.25|-88.77
Porto-Novo|C|BJ||6.50|2.60
Thimphu|C|BT||27.47|89.64
Sucre|C|BO||-19.04|-65.26
La Paz|C|BO||-16.50|-68.15
Sarajevo|C|BA||43.86|18.41
Gaborone|C|BW||-24.65|25.91
Brasília|C|BR||-15.79|-47.88
Bandar Seri Begawan|C|BN||4.90|114.94
Sofia|C|BG||42.70|23.32
Ouagadougou|C|BF||12.37|-1.52
Gitega|C|BI||-3.43|29.93
Praia|C|CV||14.93|-23.51
Phnom Penh|C|KH||11.56|104.92
Yaoundé|C|CM||3.85|11.50
Ottawa|C|CA||45.42|-75.70
Bangui|C|CF||4.39|18.56
N’Djamena|C|TD||12.13|15.06
Santiago|C|CL||-33.45|-70.67
Beijing|C|CN||39.90|116.41
Bogotá|C|CO||4.71|-74.07
Moroni|C|KM||-11.70|43.26
Brazzaville|C|CG||-4.27|15.28
Kinshasa|C|CD||-4.32|15.31
San José|C|CR||9.93|-84.08
Yamoussoukro|C|CI||6.83|-5.29
Zagreb|C|HR||45.81|15.98
Havana|C|CU||23.11|-82.37
Nicosia|C|CY||35.19|33.38
Prague|C|CZ||50.08|14.44
Copenhagen|C|DK||55.68|12.57
Djibouti|C|DJ||11.59|43.15
Roseau|C|DM||15.30|-61.39
Santo Domingo|C|DO||18.49|-69.93
Quito|C|EC||-0.18|-78.47
Cairo|C|EG||30.04|31.24
San Salvador|C|SV||13.69|-89.22
Malabo|C|GQ||3.75|8.78
Asmara|C|ER||15.32|38.93
Tallinn|C|EE||59.44|24.75
Mbabane|C|SZ||-26.31|31.14
Addis Ababa|C|ET||9.03|38.74
Suva|C|FJ||-18.14|178.44
Helsinki|C|FI||60.17|24.94
Paris|C|FR||48.86|2.35
Libreville|C|GA||0.42|9.47
Banjul|C|GM||13.45|-16.58
Tbilisi|C|GE||41.72|44.79
Berlin|C|DE||52.52|13.40
Accra|C|GH||5.60|-0.19
Athens|C|GR||37.98|23.73
Saint George’s|C|GD||12.06|-61.75
Guatemala City|C|GT||14.63|-90.51
Conakry|C|GN||9.64|-13.58
Bissau|C|GW||11.86|-15.60
Georgetown|C|GY||6.80|-58.16
Port-au-Prince|C|HT||18.54|-72.34
Tegucigalpa|C|HN||14.07|-87.19
Budapest|C|HU||47.50|19.04
Reykjavík|C|IS||64.15|-21.94
New Delhi|C|IN||28.61|77.21
Jakarta|C|ID||-6.21|106.85
Tehran|C|IR||35.69|51.39
Baghdad|C|IQ||33.31|44.36
Dublin|C|IE||53.35|-6.26
Jerusalem|C|IL||31.77|35.21
Rome|C|IT||41.90|12.50
Kingston|C|JM||18.02|-76.80
Tokyo|C|JP||35.68|139.69
Amman|C|JO||31.95|35.93
Astana|C|KZ||51.17|71.45
Nairobi|C|KE||-1.29|36.82
South Tarawa|C|KI||1.33|172.98
Pyongyang|C|KP||39.04|125.76
Seoul|C|KR||37.57|126.98
Kuwait City|C|KW||29.38|47.99
Bishkek|C|KG||42.87|74.59
Vientiane|C|LA||17.98|102.63
Riga|C|LV||56.95|24.11
Beirut|C|LB||33.89|35.50
Maseru|C|LS||-29.31|27.48
Monrovia|C|LR||6.30|-10.80
Tripoli|C|LY||32.89|13.19
Vaduz|C|LI||47.14|9.52
Vilnius|C|LT||54.69|25.28
Luxembourg|C|LU||49.61|6.13
Antananarivo|C|MG||-18.88|47.51
Lilongwe|C|MW||-13.96|33.79
Kuala Lumpur|C|MY||3.14|101.69
Malé|C|MV||4.18|73.51
Bamako|C|ML||12.64|-8.00
Valletta|C|MT||35.90|14.51
Majuro|C|MH||7.09|171.38
Nouakchott|C|MR||18.08|-15.98
Port Louis|C|MU||-20.16|57.50
Mexico City|C|MX||19.43|-99.13
Palikir|C|FM||6.92|158.16
Chișinău|C|MD||47.01|28.86
Monaco|C|MC||43.73|7.42
Ulaanbaatar|C|MN||47.89|106.91
Podgorica|C|ME||42.44|19.26
Rabat|C|MA||34.02|-6.83
Maputo|C|MZ||-25.97|32.57
Naypyidaw|C|MM||19.76|96.08
Windhoek|C|NA||-22.56|17.08
Yaren|C|NR||-0.55|166.92
Kathmandu|C|NP||27.72|85.32
Amsterdam|C|NL||52.37|4.90
Wellington|C|NZ||-41.29|174.78
Managua|C|NI||12.11|-86.24
Niamey|C|NE||13.51|2.11
Abuja|C|NG||9.08|7.40
Skopje|C|MK||42.00|21.43
Oslo|C|NO||59.91|10.75
Muscat|C|OM||23.59|58.41
Islamabad|C|PK||33.68|73.05
Ngerulmud|C|PW||7.50|134.62
Panama City|C|PA||8.98|-79.52
Port Moresby|C|PG||-9.44|147.18
Asunción|C|PY||-25.26|-57.58
Lima|C|PE||-12.05|-77.04
Manila|C|PH||14.60|120.98
Warsaw|C|PL||52.23|21.01
Lisbon|C|PT||38.72|-9.14
Doha|C|QA||25.29|51.53
Bucharest|C|RO||44.43|26.10
Moscow|C|RU||55.76|37.62
Kigali|C|RW||-1.94|30.06
Basseterre|C|KN||17.30|-62.72
Castries|C|LC||14.01|-60.99
Kingstown|C|VC||13.16|-61.22
Apia|C|WS||-13.83|-171.77
San Marino|C|SM||43.94|12.45
São Tomé|C|ST||0.34|6.73
Riyadh|C|SA||24.71|46.68
Dakar|C|SN||14.72|-17.47
Belgrade|C|RS||44.79|20.45
Victoria|C|SC||-4.62|55.45
Freetown|C|SL||8.48|-13.23
Singapore|C|SG||1.35|103.82
Bratislava|C|SK||48.15|17.11
Ljubljana|C|SI||46.06|14.51
Honiara|C|SB||-9.43|159.95
Mogadishu|C|SO||2.05|45.32
Pretoria|C|ZA||-25.75|28.19
Cape Town|C|ZA||-33.92|18.42
Bloemfontein|C|ZA||-29.12|26.21
Juba|C|SS||4.85|31.58
Madrid|C|ES||40.42|-3.70
Sri Jayawardenepura Kotte|C|LK||6.89|79.92
Khartoum|C|SD||15.50|32.56
Paramaribo|C|SR||5.85|-55.20
Stockholm|C|SE||59.33|18.07
Bern|C|CH||46.95|7.45
Damascus|C|SY||33.51|36.29
Dushanbe|C|TJ||38.56|68.79
Dodoma|C|TZ||-6.16|35.75
Bangkok|C|TH||13.76|100.50
Dili|C|TL||-8.56|125.57
Lomé|C|TG||6.13|1.22
Nukuʻalofa|C|TO||-21.14|-175.20
Port of Spain|C|TT||10.65|-61.51
Tunis|C|TN||36.81|10.18
Ankara|C|TR||39.93|32.86
Ashgabat|C|TM||37.96|58.33
Funafuti|C|TV||-8.52|179.20
Kampala|C|UG||0.35|32.58
Kyiv|C|UA||50.45|30.52
Abu Dhabi|C|AE||24.45|54.38
London|C|GB|ENG|51.51|-0.13
Washington|C|US|DC|38.91|-77.04
Montevideo|C|UY||-34.90|-56.16
Tashkent|C|UZ||41.30|69.24
Port Vila|C|VU||-17.73|168.32
Vatican City|C|VA||41.90|12.45
Caracas|C|VE||10.48|-66.90
Hanoi|C|VN||21.03|105.85
Sanaa|C|YE||15.37|44.19
Lusaka|C|ZM||-15.39|28.32
Harare|C|ZW||-17.83|31.05
Pristina|T|XK||42.66|21.17
Taipei|T|TW||25.03|121.57
Ramallah|T|PS||31.90|35.20
Hong Kong|T|HK||22.32|114.17
Macau|T|MO||22.20|113.54
San Juan|T|PR||18.47|-66.11
Nuuk|T|GL||64.18|-51.72
Nouméa|T|NC||-22.28|166.46
Papeete|T|PF||-17.54|-149.57
Alabama|S|US|AL|32.80|-86.80|6
Alaska|S|US|AK|64.20|-152.50|3.4
Arizona|S|US|AZ|34.30|-111.70|5.6
Arkansas|S|US|AR|34.90|-92.40|6
California|S|US|CA|37.20|-119.50|5
Colorado|S|US|CO|39.00|-105.50|5.8
Connecticut|S|US|CT|41.60|-72.70|7.6
Delaware|S|US|DE|39.00|-75.50|7.6
Florida|S|US|FL|28.60|-82.40|5.6
Georgia|S|US|GA|32.70|-83.40|6
Hawaii|S|US|HI|20.80|-156.30|6
Idaho|S|US|ID|44.40|-114.60|5.4
Illinois|S|US|IL|40.00|-89.20|5.8
Indiana|S|US|IN|39.90|-86.30|6.2
Iowa|S|US|IA|42.10|-93.50|6.2
Kansas|S|US|KS|38.50|-98.40|6
Kentucky|S|US|KY|37.50|-85.30|6.2
Louisiana|S|US|LA|31.10|-92.00|6
Maine|S|US|ME|45.40|-69.20|6
Maryland|S|US|MD|39.00|-76.80|7
Massachusetts|S|US|MA|42.30|-71.80|7.2
Michigan|S|US|MI|44.30|-85.40|5.6
Minnesota|S|US|MN|46.30|-94.30|5.6
Mississippi|S|US|MS|32.70|-89.70|6
Missouri|S|US|MO|38.40|-92.50|6
Montana|S|US|MT|47.00|-109.60|5.4
Nebraska|S|US|NE|41.50|-99.80|5.8
Nevada|S|US|NV|39.30|-116.60|5.4
New Hampshire|S|US|NH|43.70|-71.60|6.8
New Jersey|S|US|NJ|40.20|-74.70|7
New Mexico|S|US|NM|34.40|-106.10|5.6
New York|S|US|NY|42.90|-75.50|6
North Carolina|S|US|NC|35.60|-79.40|6
North Dakota|S|US|ND|47.50|-100.50|6
Ohio|S|US|OH|40.30|-82.80|6.2
Oklahoma|S|US|OK|35.60|-97.50|6
Oregon|S|US|OR|43.90|-120.60|5.6
Pennsylvania|S|US|PA|40.90|-77.80|6.2
Rhode Island|S|US|RI|41.70|-71.50|8
South Carolina|S|US|SC|33.90|-80.90|6.4
South Dakota|S|US|SD|44.40|-100.20|6
Tennessee|S|US|TN|35.90|-86.40|6.2
Texas|S|US|TX|31.50|-99.30|5
Utah|S|US|UT|39.30|-111.70|5.8
Vermont|S|US|VT|44.10|-72.70|7
Virginia|S|US|VA|37.50|-78.90|6.2
Washington|S|US|WA|47.40|-120.50|6
West Virginia|S|US|WV|38.60|-80.60|6.6
Wisconsin|S|US|WI|44.60|-89.90|6
Wyoming|S|US|WY|43.00|-107.50|5.8
Montgomery|T|US|AL|32.38|-86.30
Juneau|T|US|AK|58.30|-134.42
Phoenix|T|US|AZ|33.45|-112.07
Little Rock|T|US|AR|34.75|-92.29
Sacramento|T|US|CA|38.58|-121.49
Denver|T|US|CO|39.74|-104.99
Hartford|T|US|CT|41.76|-72.67
Dover|T|US|DE|39.16|-75.52
Tallahassee|T|US|FL|30.44|-84.28
Atlanta|T|US|GA|33.75|-84.39
Honolulu|T|US|HI|21.31|-157.86
Boise|T|US|ID|43.62|-116.20
Springfield|T|US|IL|39.80|-89.64
Indianapolis|T|US|IN|39.77|-86.16
Des Moines|T|US|IA|41.59|-93.62
Topeka|T|US|KS|39.05|-95.68
Frankfort|T|US|KY|38.20|-84.87
Baton Rouge|T|US|LA|30.45|-91.19
Augusta|T|US|ME|44.31|-69.78
Annapolis|T|US|MD|38.98|-76.49
Boston|T|US|MA|42.36|-71.06
Lansing|T|US|MI|42.73|-84.56
Saint Paul|T|US|MN|44.95|-93.09
Jackson|T|US|MS|32.30|-90.18
Jefferson City|T|US|MO|38.58|-92.17
Helena|T|US|MT|46.59|-112.04
Lincoln|T|US|NE|40.81|-96.70
Carson City|T|US|NV|39.16|-119.77
Concord|T|US|NH|43.21|-71.54
Trenton|T|US|NJ|40.22|-74.76
Santa Fe|T|US|NM|35.69|-105.94
Albany|T|US|NY|42.65|-73.76
Raleigh|T|US|NC|35.78|-78.64
Bismarck|T|US|ND|46.81|-100.78
Columbus|T|US|OH|39.96|-83.00
Oklahoma City|T|US|OK|35.47|-97.52
Salem|T|US|OR|44.94|-123.04
Harrisburg|T|US|PA|40.27|-76.88
Providence|T|US|RI|41.82|-71.41
Columbia|T|US|SC|34.00|-81.03
Pierre|T|US|SD|44.37|-100.35
Nashville|T|US|TN|36.16|-86.78
Austin|T|US|TX|30.27|-97.74
Salt Lake City|T|US|UT|40.76|-111.89
Montpelier|T|US|VT|44.26|-72.58
Richmond|T|US|VA|37.54|-77.44
Olympia|T|US|WA|47.04|-122.90
Charleston|T|US|WV|38.35|-81.63
Madison|T|US|WI|43.07|-89.40
Cheyenne|T|US|WY|41.14|-104.82
New York City|T|US|NY|40.71|-74.01
Brooklyn|T|US|NY|40.68|-73.94
Los Angeles|T|US|CA|34.05|-118.24
Chicago|T|US|IL|41.88|-87.63
Houston|T|US|TX|29.76|-95.37
Philadelphia|T|US|PA|39.95|-75.17
San Antonio|T|US|TX|29.42|-98.49
San Diego|T|US|CA|32.72|-117.16
Dallas|T|US|TX|32.78|-96.80
San Jose|T|US|CA|37.34|-121.89
Jacksonville|T|US|FL|30.33|-81.66
Fort Worth|T|US|TX|32.76|-97.33
Charlotte|T|US|NC|35.23|-80.84
San Francisco|T|US|CA|37.77|-122.42
Seattle|T|US|WA|47.61|-122.33
El Paso|T|US|TX|31.76|-106.49
Detroit|T|US|MI|42.33|-83.05
Memphis|T|US|TN|35.15|-90.05
Portland|T|US|OR|45.52|-122.68
Louisville|T|US|KY|38.25|-85.76
Baltimore|T|US|MD|39.29|-76.61
Milwaukee|T|US|WI|43.04|-87.91
Albuquerque|T|US|NM|35.08|-106.65
Tucson|T|US|AZ|32.22|-110.97
Fresno|T|US|CA|36.74|-119.79
Mesa|T|US|AZ|33.42|-111.83
Kansas City|T|US|MO|39.10|-94.58
Colorado Springs|T|US|CO|38.83|-104.82
Omaha|T|US|NE|41.26|-95.93
Miami|T|US|FL|25.76|-80.19
Long Beach|T|US|CA|33.77|-118.19
Virginia Beach|T|US|VA|36.85|-75.98
Oakland|T|US|CA|37.80|-122.27
Minneapolis|T|US|MN|44.98|-93.27
Tulsa|T|US|OK|36.15|-95.99
Tampa|T|US|FL|27.95|-82.46
Arlington|T|US|TX|32.74|-97.11
New Orleans|T|US|LA|29.95|-90.07
Wichita|T|US|KS|37.69|-97.34
Cleveland|T|US|OH|41.50|-81.69
Bakersfield|T|US|CA|35.37|-119.02
Aurora|T|US|CO|39.73|-104.83
Anaheim|T|US|CA|33.84|-117.91
Santa Ana|T|US|CA|33.75|-117.87
Riverside|T|US|CA|33.95|-117.40
Corpus Christi|T|US|TX|27.80|-97.40
Lexington|T|US|KY|38.04|-84.50
Pittsburgh|T|US|PA|40.44|-80.00
Anchorage|T|US|AK|61.22|-149.90
Stockton|T|US|CA|37.96|-121.29
Cincinnati|T|US|OH|39.10|-84.51
Greensboro|T|US|NC|36.07|-79.79
Plano|T|US|TX|33.02|-96.70
Newark|T|US|NJ|40.74|-74.17
Henderson|T|US|NV|36.04|-114.98
Orlando|T|US|FL|28.54|-81.38
Irvine|T|US|CA|33.68|-117.83
Jersey City|T|US|NJ|40.73|-74.08
Durham|T|US|NC|35.99|-78.90
St. Louis|T|US|MO|38.63|-90.20
Buffalo|T|US|NY|42.89|-78.88
Las Vegas|T|US|NV|36.17|-115.14
Reno|T|US|NV|39.53|-119.81
Fort Lauderdale|T|US|FL|26.12|-80.14
St. Petersburg|T|US|FL|27.77|-82.64
Savannah|T|US|GA|32.08|-81.09
Charleston|T|US|SC|32.78|-79.93
Boulder|T|US|CO|40.01|-105.27
Spokane|T|US|WA|47.66|-117.43
Tacoma|T|US|WA|47.25|-122.44
Rochester|T|US|NY|43.16|-77.61
Knoxville|T|US|TN|35.96|-83.92
Chattanooga|T|US|TN|35.05|-85.31
Birmingham|T|US|AL|33.52|-86.80
Grand Rapids|T|US|MI|42.96|-85.67
Ann Arbor|T|US|MI|42.28|-83.74
Sioux Falls|T|US|SD|43.54|-96.73
Fargo|T|US|ND|46.88|-96.79
Billings|T|US|MT|45.78|-108.50
Missoula|T|US|MT|46.87|-113.99
Provo|T|US|UT|40.23|-111.66
Santa Barbara|T|US|CA|34.42|-119.70
Palm Springs|T|US|CA|33.83|-116.55
Key West|T|US|FL|24.56|-81.78
Burlington|T|US|VT|44.48|-73.21
Portland|T|US|ME|43.66|-70.26
Worcester|T|US|MA|42.26|-71.80
Cambridge|T|US|MA|42.37|-71.11
New Haven|T|US|CT|41.31|-72.92
Wilmington|T|US|DE|39.74|-75.55
Norfolk|T|US|VA|36.85|-76.29
Asheville|T|US|NC|35.60|-82.55
Myrtle Beach|T|US|SC|33.69|-78.89
Mobile|T|US|AL|30.69|-88.04
Shreveport|T|US|LA|32.53|-93.75
Lubbock|T|US|TX|33.58|-101.86
Amarillo|T|US|TX|35.22|-101.83
Waco|T|US|TX|31.55|-97.15
Round Rock|T|US|TX|30.51|-97.68
Laredo|T|US|TX|27.53|-99.48
Brownsville|T|US|TX|25.90|-97.50
McAllen|T|US|TX|26.20|-98.23
Galveston|T|US|TX|29.30|-94.80
Flagstaff|T|US|AZ|35.20|-111.65
Sedona|T|US|AZ|34.87|-111.76
Scottsdale|T|US|AZ|33.49|-111.93
Tempe|T|US|AZ|33.43|-111.94
Eugene|T|US|OR|44.05|-123.09
Bend|T|US|OR|44.06|-121.31
Fairbanks|T|US|AK|64.84|-147.72
Hilo|T|US|HI|19.72|-155.08
Akron|T|US|OH|41.08|-81.52
Dayton|T|US|OH|39.76|-84.19
Toledo|T|US|OH|41.65|-83.54
Fort Wayne|T|US|IN|41.08|-85.14
Springfield|T|US|MO|37.21|-93.29
Green Bay|T|US|WI|44.51|-88.01
Duluth|T|US|MN|46.79|-92.10
Rapid City|T|US|SD|44.08|-103.23
Aspen|T|US|CO|39.19|-106.82
Las Cruces|T|US|NM|32.32|-106.76
Atlantic City|T|US|NJ|39.36|-74.42
Princeton|T|US|NJ|40.35|-74.66
Ithaca|T|US|NY|42.44|-76.50
Syracuse|T|US|NY|43.05|-76.15
Toronto|T|CA||43.65|-79.38
Montreal|T|CA||45.50|-73.57
Vancouver|T|CA||49.28|-123.12
Calgary|T|CA||51.05|-114.07
Edmonton|T|CA||53.55|-113.49
Winnipeg|T|CA||49.90|-97.14
Quebec City|T|CA||46.81|-71.21
Halifax|T|CA||44.65|-63.58
Guadalajara|T|MX||20.66|-103.35
Monterrey|T|MX||25.69|-100.32
Tijuana|T|MX||32.51|-117.04
Cancún|T|MX||21.16|-86.85
Puebla|T|MX||19.04|-98.21
São Paulo|T|BR||-23.55|-46.63
Rio de Janeiro|T|BR||-22.91|-43.17
Salvador|T|BR||-12.97|-38.50
Belo Horizonte|T|BR||-19.92|-43.94
Fortaleza|T|BR||-3.72|-38.54
Recife|T|BR||-8.05|-34.88
Porto Alegre|T|BR||-30.03|-51.23
Curitiba|T|BR||-25.43|-49.27
Manaus|T|BR||-3.12|-60.02
Córdoba|T|AR||-31.42|-64.18
Rosario|T|AR||-32.95|-60.64
Mendoza|T|AR||-32.89|-68.83
Valparaíso|T|CL||-33.05|-71.62
Medellín|T|CO||6.24|-75.58
Cali|T|CO||3.45|-76.53
Cartagena|T|CO||10.39|-75.48
Guayaquil|T|EC||-2.17|-79.92
Cusco|T|PE||-13.53|-71.97
Santa Cruz de la Sierra|T|BO||-17.78|-63.18
Maracaibo|T|VE||10.65|-71.64
Manchester|T|GB|ENG|53.48|-2.24
Birmingham|T|GB|ENG|52.49|-1.89
Liverpool|T|GB|ENG|53.41|-2.98
Leeds|T|GB|ENG|53.80|-1.55
Glasgow|T|GB|SCT|55.86|-4.25
Edinburgh|T|GB|SCT|55.95|-3.19
Cardiff|T|GB|WLS|51.48|-3.18
Belfast|T|GB|NIR|54.60|-5.93
Bristol|T|GB|ENG|51.45|-2.59
Oxford|T|GB|ENG|51.75|-1.26
Cambridge|T|GB|ENG|52.21|0.12
England|R|GB|ENG|52.85|-1.50|6
Scotland|R|GB|SCT|56.80|-4.20|6
Wales|R|GB|WLS|52.30|-3.70|6
Northern Ireland|R|GB|NIR|54.65|-6.70|6
Cork|T|IE||51.90|-8.47
Marseille|T|FR||43.30|5.37
Lyon|T|FR||45.76|4.84
Toulouse|T|FR||43.60|1.44
Nice|T|FR||43.71|7.26
Bordeaux|T|FR||44.84|-0.58
Lille|T|FR||50.63|3.06
Strasbourg|T|FR||48.57|7.75
Nantes|T|FR||47.22|-1.55
Hamburg|T|DE||53.55|9.99
Munich|T|DE||48.14|11.58
Cologne|T|DE||50.94|6.96
Frankfurt|T|DE||50.11|8.68
Stuttgart|T|DE||48.78|9.18
Düsseldorf|T|DE||51.23|6.77
Dresden|T|DE||51.05|13.74
Leipzig|T|DE||51.34|12.37
Barcelona|T|ES||41.39|2.17
Valencia|T|ES||39.47|-0.38
Seville|T|ES||37.39|-5.98
Bilbao|T|ES||43.26|-2.93
Málaga|T|ES||36.72|-4.42
Porto|T|PT||41.15|-8.61
Milan|T|IT||45.46|9.19
Naples|T|IT||40.85|14.27
Turin|T|IT||45.07|7.69
Florence|T|IT||43.77|11.26
Venice|T|IT||45.44|12.32
Bologna|T|IT||44.49|11.34
Palermo|T|IT||38.12|13.36
Rotterdam|T|NL||51.92|4.48
The Hague|T|NL||52.08|4.30
Utrecht|T|NL||52.09|5.12
Antwerp|T|BE||51.22|4.40
Geneva|T|CH||46.20|6.14
Zurich|T|CH||47.38|8.54
Basel|T|CH||47.56|7.59
Salzburg|T|AT||47.81|13.04
Kraków|T|PL||50.06|19.94
Gdańsk|T|PL||54.35|18.65
Wrocław|T|PL||51.11|17.04
Gothenburg|T|SE||57.71|11.97
Malmö|T|SE||55.60|13.00
Bergen|T|NO||60.39|5.32
Aarhus|T|DK||56.16|10.20
Saint Petersburg|T|RU||59.93|30.34
Novosibirsk|T|RU||55.01|82.93
Yekaterinburg|T|RU||56.84|60.61
Vladivostok|T|RU||43.12|131.89
Istanbul|T|TR||41.01|28.98
Izmir|T|TR||38.42|27.14
Antalya|T|TR||36.90|30.71
Thessaloniki|T|GR||40.64|22.94
Odesa|T|UA||46.48|30.72
Lviv|T|UA||49.84|24.03
Kharkiv|T|UA||49.99|36.23
Dubai|T|AE||25.20|55.27
Jeddah|T|SA||21.49|39.19
Mecca|T|SA||21.42|39.83
Tel Aviv|T|IL||32.09|34.78
Haifa|T|IL||32.79|34.99
Isfahan|T|IR||32.65|51.67
Alexandria|T|EG||31.20|29.92
Casablanca|T|MA||33.57|-7.59
Marrakesh|T|MA||31.63|-7.99
Lagos|T|NG||6.52|3.38
Kano|T|NG||12.00|8.52
Ibadan|T|NG||7.38|3.95
Port Harcourt|T|NG||4.82|7.03
Abidjan|T|CI||5.36|-4.01
Johannesburg|T|ZA||-26.20|28.05
Durban|T|ZA||-29.86|31.02
Mombasa|T|KE||-4.04|39.67
Dar es Salaam|T|TZ||-6.79|39.21
Zanzibar City|T|TZ||-6.17|39.20
Lubumbashi|T|CD||-11.66|27.48
Shanghai|T|CN||31.23|121.47
Guangzhou|T|CN||23.13|113.26
Shenzhen|T|CN||22.54|114.06
Chengdu|T|CN||30.57|104.07
Chongqing|T|CN||29.56|106.55
Wuhan|T|CN||30.59|114.31
Xi’an|T|CN||34.34|108.94
Hangzhou|T|CN||30.27|120.16
Nanjing|T|CN||32.06|118.80
Tianjin|T|CN||39.34|117.36
Harbin|T|CN||45.80|126.53
Kunming|T|CN||25.04|102.71
Lhasa|T|CN||29.65|91.17
Osaka|T|JP||34.69|135.50
Kyoto|T|JP||35.01|135.77
Yokohama|T|JP||35.44|139.64
Nagoya|T|JP||35.18|136.91
Sapporo|T|JP||43.06|141.35
Fukuoka|T|JP||33.59|130.40
Hiroshima|T|JP||34.39|132.46
Naha|T|JP||26.21|127.68
Busan|T|KR||35.18|129.08
Incheon|T|KR||37.46|126.71
Mumbai|T|IN||19.08|72.88
Kolkata|T|IN||22.57|88.36
Chennai|T|IN||13.08|80.27
Bengaluru|T|IN||12.97|77.59
Hyderabad|T|IN||17.39|78.49
Ahmedabad|T|IN||23.02|72.57
Pune|T|IN||18.52|73.86
Jaipur|T|IN||26.91|75.79
Agra|T|IN||27.18|78.01
Varanasi|T|IN||25.32|82.97
Panaji|T|IN||15.49|73.83
Kochi|T|IN||9.93|76.27
Karachi|T|PK||24.86|67.01
Lahore|T|PK||31.55|74.34
Chittagong|T|BD||22.36|91.78
Colombo|T|LK||6.93|79.86
Ho Chi Minh City|T|VN||10.82|106.63
Da Nang|T|VN||16.05|108.21
Chiang Mai|T|TH||18.79|98.98
Phuket|T|TH||7.88|98.39
Cebu City|T|PH||10.32|123.89
Davao City|T|PH||7.07|125.61
Surabaya|T|ID||-7.26|112.75
Denpasar|T|ID||-8.65|115.22
Bandung|T|ID||-6.92|107.62
Yangon|T|MM||16.84|96.17
George Town|T|MY||5.41|100.33
Almaty|T|KZ||43.24|76.89
Samarkand|T|UZ||39.65|66.96
Sydney|T|AU||-33.87|151.21
Melbourne|T|AU||-37.81|144.96
Brisbane|T|AU||-27.47|153.03
Perth|T|AU||-31.95|115.86
Adelaide|T|AU||-34.93|138.60
Hobart|T|AU||-42.88|147.33
Darwin|T|AU||-12.46|130.84
Gold Coast|T|AU||-28.02|153.40
Cairns|T|AU||-16.92|145.77
Auckland|T|NZ||-36.85|174.76
Christchurch|T|NZ||-43.53|172.64
Queenstown|T|NZ||-45.03|168.66`;
