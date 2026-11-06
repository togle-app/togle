// First names, to tell someone said to by name ("Marko, can you…") from a word that opens a question the same way
// ("Security, how do you…?", "Usput, kad…?"). Lowercase and without accents, as foldName in prompts.ts gives them.
// The US Social Security Administration's baby names (public domain): those among a year's 1,000 most given in at
// least five years from 1940 to 2008, less the ones that are also everyday words, places, brands or tech ("Summer",
// "Chase", "Paris", "Sydney", "Ruby", "Cassandra"). Then common names in Croatia and its neighbours, with the forms
// Croatian calls them by ("Ivane", "Majo", "Ivice"), and elsewhere in Europe, Turkey, the Middle East, India and East
// Asia. None that is also a word a sentence opens with ("Jasno." is "Got it.", "Baš?" is "Really?", "Mate, …").
export const FIRST_NAMES: ReadonlySet<string> = new Set(
  `
aaliyah aaron aarti abagail abbey abbie abbigail abby abdul abdullah abe abel abhishek abigail abigale abigayle
abraham abram abril adam adan addie addison addyson adela adele adeline aden adis adise aditya adna adnan adnane
adno adolfo adolph adolphus adonis adrain adria adrian adriana adriane adrianna adrianne adriel adrien adrienne
agnes agnieszka agustin ahmad ahmed ahmet aida aidan aiden aido aiko aileen aimee ainsley aisha aishwarya aiyana aja
ajay ajda ajdo ajla ajlo akash akeem akira akshay alain alaina alan alana alani alanna alayna alba albert alberta
albertha alberto alden aldo aleah alec alecia aleena alejandra alejandro alek aleksa aleksandar aleksandare
aleksandra aleksandre alekso alen alena alene alenka alenko ales alese alesha alesia alessandra alessandro alessia
alessio aleta alex alexander alexandra alexandre alexandrea alexandro alexandru alexey alexia alexis alexus alexys
alexzander alfonso alfonzo alford alfred alfreda alfredo ali alia alice alicia alija alijah alijo alina aline alisa
alisha alison alissa alivia aliya aliyah aliza alize aljaz aljaze allan allen allene allie allison ally allyn
allyson allyssa alma almir almire almo alok alondra alonso alonzo alphonse alphonso alta althea alton alva alvaro
alvie alvin alvis alyce alycia alysa alyse alysha alysia alyson alyssa aman amanda amani amar amara amare amari
amarion amaris amaya amber ambrose amel amele amelia amelie amer amere ami amie amila amilo amina amino amir amira
amire amit amiya amiyah amos amra amre amro amy amya ana anabel anahi anais anamarija anamarijo anand ananya
anastasia anaya anders anderson andjela andjelo andra andrae andraz andraze andre andrea andreas andreea andrei
andrej andreju andreo andres andrew andrey andria andrija andrijo andy anel anele anette angel angela angelia
angelic angelica angelina angeline angelique angelita angelo angie anica anice anico anika anil anissa anita anito
anitra aniya aniyah anja anjali anjanette anjelica anjo anka anke ankica ankice ankico ankit ankita anko ankur ann
anna annabel annabella annabelle annalise annamarie anne annemarie annetta annette annie annika annmarie ano anouk
ansley anson ante anthony antione antionette anto antoine antoinette anton antone antonella antonia antonija
antonijo antonio antony antun antune antwan antwon anup anwar anya anze anđela anđelo april araceli aracely arash
archie arden ardis ardith areli arely aretha ari aria ariana arianna aric ariel arielle arjun arlan arleen arlen
arlene arlie arlin arline arlo arlyn armand armando armani armin armine arnaud arnav arnold arnoldo arnulfo aron
arron art arther arthur artie artis arturo arun arvid arvin aryan aryana aryanna asa asad asha ashanti ashely asher
ashish ashlea ashlee ashleigh ashley ashli ashlie ashly ashlyn ashlynn ashok ashton ashtyn asja asjo astrid atticus
attila aubree aubrey aubrie audie audra audrey august augustine augustus aurelia aurelie aurelio austen auston
austyn ava averie avery avis axel ayaka ayana ayanna aydan ayden aydin ayesha ayla aylin ayse azra azro babette
bailee bailey balazs bambi baptiste barb barbara barbaro barbie barbra barney barrett barrie barron barry bart
bartholomew barton bartosz barıs basil baylee beatrice beatriz beau becky belen belinda bella belma belmo belva ben
bence benedetta benedict benita benito benjamen benjamin benjamine bennett bennie benny benoit benton berenice
bernadette bernadine bernard bernardo bernd bernice bernie berniece bernita berry bert berta bertha bertie bertram
bertrand beryl bessie beth bethany betsy bette bettie bettina betty bettye beulah beverley beverly bianca bilal
biljana biljano bill billie billy billye bine birdie birgit biserka biserko bjorn blagoja blagojo blaine blair
blaise blake blanca blanche blane blanka blanko blaz blaze bob bobbi bobbie bobby bogdan bogdane bohdan bojan bojana
bojane bojano bonita bonnie bonny booker bor bore boris borise borna borno bostjan bostjane boyce boyd bozena bozeno
bozidar bozidare bozidre bozo brad braden bradford bradley bradly brady bradyn braeden braedon braiden bram brandan
brandee branden brandi brandie brandin brandon brandt brandy brandyn branimir branimire branislav branislave branka
branko brannon branson brant bratislav bratislave braxton brayan brayden braydon braylon breana breann breanna
breanne bree brenda brendan brenden brendon brenna brennan brennen brennon brent brenton breonna bret brett bria
brian briana brianna brianne brice bridget bridgett bridgette brielle brien brigette brigitte brion brionna brisa
britany britney britni britt brittaney brittani brittanie brittany brittnee brittney brittni brittny britton brock
broderick brodie brody bronson brook brooke brooklynn brooks bruce bruna bruno bryan bryana bryanna bryant bryce
brycen brynn bryon bryson buck bud buddy buffy buford burak burl burt burton buster butch byron cade caden cadence
cael caiden caitlin caitlyn caitlynn cal cale caleb caleigh cali calista callie calvin cameron camila camilla
camille campbell camren camron camryn candace candi candice candida candis candy cannon cara caren carey cari carie
carin carina carisa carissa carl carla carlee carleen carlene carleton carley carli carlie carlo carlos carlotta
carlton carly carmel carmela carmelita carmella carmelo carmen carmine carnell carol carolann carole carolee
caroline carolyn carolyne carolynn caron carri carrie carrol carroll carson carter cary caryl caryn casandra casey
casie cason cassidy cassie cassondra catalina caterina catharine catherine cathey cathi cathie cathleen cathrine
cathryn cathy catina catrina cayden cayla cecelia cecil cecile cecilia cecily cedric cedrick celena celeste
celestine celia celina celine cem cesar chad chadd chadrick chadwick chaim chana chanda chandler chandra chanel
chanelle channing chantal chantel chantelle charissa charisse charla charleen charlene charles charley charlie
charline charlize charlotte charmaine charolette chasity chauncey chaya chaz chelsea chelsey chelsi chelsie cheri
cherie cherise cherri cherrie cherry cheryl cheryle cheryll chester chet cheyanne chiara chiquita chloe chris
christa christal christel christen christene christi christian christiana christie christin christina christine
christoper christophe christopher christos christy chrystal chuck chyna ciara ciera cierra cinda cindi cindy citlali
clair claire clara clarance clare clarence clarice clarissa clark clarke claud claudette claudia claudie claudine
claudio clay clayton clem clement clementine cleo cletus cleve cliff clifford clifton clint clinton clyde coby codey
codie cody cohen colby cole coleen coleman colette colin colleen collette collin colt colten colton concetta conner
connie connor conor conrad constance constantine consuelo cooper cora corbin cordelia cordell corey cori corina
corine corinna corinne corliss cornelia cornelius cornell corrie corrina corrine cortez cortney cory coty courtney
coy craig crawford cris crista cristal cristi cristian cristin cristina cristobal cristofer cristopher cristy crt
crte cruz crystal cullen curt curtis curtiss cydney cyndi cynthia cyril cyrus daan daija daiki daisha daisy dakotah
dale dalia dalibor dalibore dallin dalton damarion damaris dameon damian damien damion damir damire damjan damjane
damon damond dan dana dandre dane danelle danette dangelo dania danial danica danice danico daniel daniela daniele
daniella danielle danijel danijela danijele danijelo danika danita danna dannie danny dante danyelle daphne daquan
dara darby darci darcie darcy darell daren daria darian darien darin dario darion darius darko darla darleen darlene
darline darnell darold daron darrel darrell darren darrian darrick darrien darrin darrion darrius darron darry
darryl darryle darvin darwin daryl daryle dashawn dasia dave davey davian david davide davin davina davion davis
davon davonte davor davore dawn dawna dawson dax dayana dayanara dayna dayton deacon dean deana deandre deangelo
deann deanna deanne deasia deb debbi debbie debbra debby debi debora deborah debra debrah declan dedra dedric
dedrick dee deeann deedee deena deepa deepak deepika deidra deidre deion deirdre deja dejan dejane dejuan del
delaney delano delbert delia delilah delisa della delma delmar delmas delmer delois delores deloris delphine delton
delvin demarco demarcus demario demarion demetria demetrius demi demond dena deneen denice denis denise denisse
deniz dennie dennis denny denton denzel denzil deon deondre deontae deonte dequan dereck derek deric derick derik
deron derrek derrell derrick derwin deshaun deshawn desirae desiree desmond dessie destany destin destinee destiney
destini devan devante deven devin devon devonta devontae devonte devyn dewayne dewey dewitt dexter diamond dian
diana diane diann dianna dianne dick dickie diego dieter dijana dijano dillan dillard dillion dillon dimitar
dimitare dimitre dimitri dimitrije dimitris dina dinah dinko dino dion dionne dionte dirk divya dixie djordje dmitry
dollie dolly dolores domagoj domagoju domen domene domenic domenico dominga domingo dominic dominice dominick
dominik dominique dominque domonique don dona donal donald donavan donavon donell donita donn donna donnell donnie
donny donovan donta dontae donte dora dorcas dorde doreen dorene doretha dori dorian doriane dorinda doris doro
dorotea doroteo dorothea dorothy dorris dorsey dortha dorthy dottie doug douglas douglass dovie doyle dragan dragana
dragane dragano dragica dragice dragico dragisa dragiso dragoljub dragoljube dragoslav dragoslave dragutin dragutine
drake draven drazen drazene drema drew drucilla duane duarte dubravka dubravko duc dudley duje dulce duncan dunja
dunjo durwood dusan dusane dustin dusty duwayne dwain dwaine dwane dwayne dwight dylan dyllan dylon dzana dzano
dzenan dzenana dzenane dzenano dzevad dzevade ean earl earle earlene earline earnest earnestine easton eboni ebony
ece edd eddie eddy eden edgar edgardo edi edie edin edina edine edino edison edith edmond edmund edna edoardo edsel
eduardo edward edwardo edwin edwina edythe effie efrain efrem efren ehsan eileen ela elaina elaine elayne elbert
elda elden eldin eldine eldon eldridge eleanor eleanore elena eleni eleno eli elian eliana elias elida eliezer elif
elijah elin elinor eliot elisa elisabeth elise eliseo elisha elissa eliza elizabeth ella elle ellen ellie elliot
elliott ellis ellsworth elma elmer elmo elmore elnora elo elodie eloise elouise eloy elroy elsa elsie elton elva
elvin elvir elvira elvire elvis elvise elwin elwood elyse elyssa elzie ema emanuel emanuele emely emerson emery emi
emil emile emilee emilia emiliano emilie emilio emily emin emina emine emino emir emire emma emmalee emmanuel emmett
emmitt emo emory emre ena enid eno enoch enrico enrique enzo eric erica erich erick ericka erik erika erin erlinda
erma ermin ermine ernest ernestina ernestine ernesto ernie errol ervin ervine erwin eryn esma esmeralda esmo
esperanza esra essie esteban estefania estela estella estelle ester estevan esther estrella eszter ethan ethel ethen
etta eugene eugenia eugenio eula eunice eva evan evangelina evangeline evans eve evelin evelyn everett everette
evette evon evonne ewa ezekiel ezell ezequiel ezra fabian fabio fabiola fadi faisal faith fallon fang fannie farid
faron farrah farrell faruce faruk fatima fatma fawn fay faye federica federico felecia felicia felicity felipe
felisha felix felton femke feng ferdinand fern fernanda fernando fidel filip filipe filippo finn fiona fletcher
fleur flor flora florence florian florin florine flossie floyd fonda forrest foster fran frances francesca francesco
francine francis francisca francisco franco francois frane franjo frank frankie franklin franklyn franziska fred
freda freddie freddy frederic frederick fredric fredrick freeman freida freya frida frieda fritz gabor gabriel
gabriela gabriele gabriella gabrielle gabrielo gabrijela gabrijelo gael gage gaige gail gal gale galen galilea
ganesh gannon garett garey garfield garland garnet garnett garold garret garrett garrick garrison garry garth gary
gasper gaspere gaurav gaven gavin gavyn gay gaye gayla gayle gaylen gaylon gaylord gaynell gearld gearldine geary
gena genaro gene genevieve geoffrey george georgeann georgene georgetta georgette georgiana georgiann georgianna
georgie georgina gerald geraldine geralyn gerard gerardo gerd geri germaine german gerold gerri gerry gertie
gertrude gia giana giancarlo gianluca gianna gianni gideon gigi gil gilbert gilberto gilda giles gillian gina
ginevra ginger ginny gino giorgia giorgio giorgos giovani giovanna giovanni giovanny gisele giselle gisselle gita
giulia giuseppe giuseppina gladys glen glenda glendon glenn glenna glinda gloria glynda glynis glynn goce goldie
goncalo gonzalo goran gorana gorane gorano gordan gordana gordane gordano gordon grace gracelyn gracie graciela
grady graham grant granville grayson greg gregg greggory gregor gregore gregorio gregory greta gretchen greyson
grgur grgure griffin griselda grover grzegorz guadalupe guillaume guillermo gunnar gunner gunter gunther gus gussie
gustavo guy gwen gwendolyn haden hadley hailee hailey hailie hakan hakeem hal haleigh haley hali halie halle hallie
hamid hamza hana hank hanna hannah hano hans hao hardy hari haris harise harlan harland harley harmon harold harper
harrell harriet harriett harriette harris harrison harry harsh haruka harun harune haruto harvey hasan hasane hassan
hatice hattie hayden haylee hayley haylie hayward haywood hazel heath heather hector hedy heidi heike heiko heinz
helen helena helene heleno hellen helmut hendrik henrietta henrik henry herb herbert heriberto herlinda herman
hermon hernan herschel hershel hester hieu hilary hilda hillary hilton hira hiram hiroshi hobert holden holger holli
hollie hollis holly homer hope horace horst hosea hossein howard howell hoyt hrvoje hubert huey hugh hugo hui
humberto hunter huong huseyin hussein hyun ian ibrahim ida idella iesha ignacio igor igore ike ila ilaria ilene
iliana ilija ilijo ilona ima imani imelda immanuel imogene imran ina ines inez ingo ingrid inigo ino ioana iola iona
ionut ira irena irene ireno irina iris irise irma irvin irving irwin isaac isaak isabel isabela isabell isabella
isabelle isai isaiah isaias ishaan isiah isidora isidoro isidro isis ismael ismail issac itzel iva ivan ivana
ivancica ivancice ivancico ivane ivanka ivanko ivano ive ivette ivica ivice ivico ivo ivona ivono ivor ivore ivy
iyana iyanna izabella izaiah jabari jacalyn jace jacey jack jackeline jacki jackie jacklyn jackson jacky jaclyn
jacob jacoby jacque jacquelin jacqueline jacquelyn jacques jacquline jada jade jaden jadon jadranka jadranko jadyn
jae jaeden jaelyn jagger jagoda jagodo jaheim jaida jaiden jaidyn jailyn jaime jaimee jaimie jair jairo jaka jakayla
jake jakob jakobe jakov jakove jakub jaleel jaleesa jalen jalisa jaliyah jalyn jalynn jamaal jamal jamar jamarcus
jamari jamarion jame jameel jamel james jameson jamey jami jamie jamil jamila jamin jamir jamison jammie jamya jan
jana janae janay jane janeen janel janell janelle janessa janet janette janey janez janeze janiah janice janie
janine janis janiya janiyah jann janna jannette jannie jannik jaquan jaqueline jarad jared jaren jarod jaron jarred
jarrell jarret jarrett jarrod jarvis jase jasen jasmin jasmina jasmine jasminka jasminko jasmino jasmyn jasna jason
jasper jaunita javen javier javion javon javonte jaxon jaxson jay jayce jaycee jayda jayden jaydin jaydon jayla
jaylan jaylee jayleen jaylen jaylene jaylin jaylon jaylyn jaylynn jayme jayne jayson jazlyn jazmin jazmine jazmyn
jazmyne jean jeana jeanetta jeanette jeanie jeanine jeanna jeanne jeannette jeannie jeannine jed jedediah jedidiah
jeff jefferey jefferson jeffery jeffrey jeffry jelena jeleno jelica jelice jelico jen jena jenelle jenifer jenna
jenni jennie jennifer jennings jenny jens jerad jerald jeraldine jeramiah jeramie jeramy jere jered jerel jereme
jeremey jeremiah jeremie jeremy jeri jerica jerilyn jerimiah jermain jermaine jermey jernej jerneja jernejo jerneju
jerod jerold jerome jeromy jerrell jerri jerrica jerrie jerrod jerrold jerry jesica jesper jess jesse jessenia jessi
jessica jessie jessika jessy jesus jett jevon jewell jie jiho jill jillian jim jimena jimin jimmie jimmy jing jiri
jisoo joachim joan joana joanie joann joanna joanne joao joaquin jocelyn jocelyne jochen jodi jodie jody joe joel
joelle joellen joesph joetta joey johan johana johanna johathan john johnathan johnathon johnie johnna johnnie
johnny johnpaul johnson joleen jolene jolie jon jonah jonas jonathan jonathon joni jonna jonnie joost jordan jorden
jordon jordy jordyn jorg jorge jory jose josef josefina joselyn joseph josephine josette josh joshua josiah josie
josip josipa josipe josipo josko joslyn josue jovan jovana jovane jovani jovanni jovanny jovano jovany joy joyce
joycelyn jozo juan juana juanita judah judd jude judi judie judith judson judy jules juli julian juliana juliann
julianna julianne julie julien juliet juliette julio julissa julius june junior junius juraj juraju jure jurgen
jurica jurice jurico jurju justen justin justina justine juston justus justyn justyna juwan kacey kaci kacie kacy
kade kadeem kaden kadence kadin kaeden kaela kaelyn kai kaia kaiden kaila kailee kailey kailyn kaitlin kaitlyn
kaitlynn kaiya kala kale kaleb kaleigh kalen kaley kali kalie kaliyah kallie kalvin kalyn kamari kamden kameron kami
kamil kamren kamron kamryn kandace kandi kandice kandy kane kara karan kareem karen kari karie karim karin karina
karissa karl karla karlee karlene karley karli karlie karlo karly karol karolina karolyn karon karren karri karrie
karson karthik karyn kasandra kasey kasie kason kassandra kassidy kassie kata katalin katarina katarino katarzyna
kate katelin katelyn katelynn katerina kathaleen katharine katherine katheryn kathi kathie kathleen kathlene kathlyn
kathrin kathrine kathryn kathy kati katia katica katice katico katie katina katja katjo katlin katlyn katlynn kato
katrin katrina katy kavita kavya kay kaya kaycee kayden kaydence kaye kayla kaylah kaylee kayleigh kaylen kayley
kayli kaylie kaylin kaylyn kaylynn kazuki keagan keanu keaton kecia keegan keely keenan keesha kegan keiko keira
keisha keith kelby keli kellee kellen kelley kelli kellie kelly kelsea kelsey kelsi kelsie kelton kelvin kemal ken
kenan kenane kendal kendall kendra kendrick kenia kenisha kenji kenna kennedi kennedy kenneth kenney kennith kennth
kenny kent kenta kenton kenyatta kenyon kenzie keon keri kerim kerime kermit kerri kerrie kerry kerstin kerwin kesha
keshawn keshia kevan keven kevin kevon keyla keyon keyshawn khadijah khaled khalid khalil kian kiana kianna kiara
kiel kiera kieran kierra kiersten kieth kiley killian kim kimberely kimberlee kimberley kimberli kimberlie kimberly
kimora kinsey kip kipp kira kirby kirk kirsten kirstie kirstin kirt kisha kitty klara klaus klemen klemene kobe koby
kody kolby kole kolton konner konnor korbin korey kori kortney kory kosta kostas kosto kourtney kraig kresimir
kresimire kreso kris krishna krista kristal kristan kristen kristi kristian kristie kristijan kristijana kristijane
kristijano kristin kristina kristine kristino kristofer kristoffer kristopher kristy kristyn kruno krunoslav
krunoslave krysta krystal krysten krystin krystina krystle krzysztof kunal kurt kurtis kwame kya kyla kylan kyle
kylee kyleigh kyler kylie kyra lacey laci lacie lacy ladarius ladonna laila lainey lakeisha laken lakesha lakeshia
lakisha lakshmi lamar lamija lamijo lamont lamonte lana lance landen landon landyn lane lanette laney lani lanny
lano laquita lara laraine larissa laro laron larry lars lary lashanda lashawn lashonda laszlo latanya latarsha
latasha latisha latonia latonya latoria latosha latoya latrell latrice latricia latrina laura laureen laurel lauren
laurence laurene laurent lauretta lauri laurie lauryn lavern laverne lavon lavonne lawanda lawerence lawrance
lawrence lawson layla layne layton lazar lazare lazaro lazre lea leah leander leandra leann leanna leanne leatha lee
leeann leeroy leesa lei leia leif leigh leila leilani leisa lejla lejlo lela leland lelia lemuel len lena lenard
lennie lenny leno lenora lenore leo leola leon leona leonard leonardo leone leonel leonie leono leonor leopoldo
leora leota leroy les lesa lesia leslee lesley lesli leslie lesly lessie lester leta letha leticia letitia lettie
levi levon lewis lex lexi lexie li lia liam liana libby lidija lidijo lila lilia lilian liliana lillian lilliana
lillie lilly lily lin lina lincoln linda lindell lindsay lindsey lindy linette linh linnea linnie linsey linwood
lionel lisa lise lisette lissette litzy liz liza lizabeth lizbeth lizeth lizette lizzie ljiljana ljiljano ljubica
ljubice ljubico ljubo ljubomir ljubomire ljupco lloyd logan lois lola lolita lon lona loni lonna lonnie lonny lonzo
lora loraine loran loreen lorelei loren lorena lorene loreno lorenza lorenzo loretta lori loriann lorie lorin
lorinda lorine lorna lorne lorraine lorri lorrie lotte lottie lou louann louella louie louis louisa louise lourdes
louvenia lovie lovre lovro lowell loy loyal loyce loyd luana luann luanne luca lucas luce lucero lucia lucian
luciana luciano lucie lucien lucija lucijo lucile lucille lucinda lucious lucius lucretia lucy luella luigi luis
luisa luka lukas luke luko lula lupe lura luther luz lydia lyla lyle lyman lyn lynda lyndon lyndsay lyndsey lynette
lynn lynne lynnette lynsey lynwood mabel mable mac macey machelle maci macie mack mackenzie macy madalyn madalynn
maddison maddox madeleine madeline madelyn madelynn madge madilyn madisen madison madisyn madonna mads madyson mae
maegan maeve magan magdalena magdalene magdaleno magen maggie magnus mahesh mahlon mahmoud mai maia maida maido
maira maja majo makaila makayla makena makenna makenzie malachi malakai malaki malcolm malcom maleah malia malik
malinda malissa maliyah mallory malte mamie manca manco mandi mandy manfred manish manoj manon manuel manuela mara
maranda marc marcel marcelino marcella marcellus marcelo marci marcia marcie marcin marco marcos marcus marcy maren
margaret margarett margarette margarita margarito marge margery margie margo margot margret marguerite mari maria
mariah mariam marian mariana mariann marianna marianne mariano maribel maribeth marica marice maricela marico marie
mariel mariela marietta marija marijan marijana marijane marijano marijeta marijeto marijo marilee marilou marilyn
marilynn marin marina marine marinko marino mario marion marisa marisela marisol marissa marita maritza marjan
marjane marjorie marjory mark markel markell marko markus marla marlee marleen marlena marlene marley marlin marlo
marlon marlyn marlys marni marnie maro marques marquez marquis marquise marquita marsha marshall marta martell
martez martha marti martin martina martino marto marty marva marvin mary maryam maryann maryanne marybeth maryellen
maryjane maryjo marylee marylin marylou marylyn masa maso mason massimo matea matej mateja matejo mateju mateo
mateusz matevz matevze mathew mathias mathieu mathilde mathis matias matija matijo matilda matilde matjaz matjaze
matko mato matt matteo matthew matthias mattia mattie maude maudie maura maureen maurice mauricio maurine mauro
maury maverick mavis max maxie maxim maxime maximilian maximillian maximo maximus maxine maxwell may maya maynard
mayra mazie małgorzata mcarthur mckayla mckenna mckenzie mckinley meagan meaghan mechelle mediha mediho meera meg
megan meggan meghan meghann mehdi mehmet mekhi mel melanie melany melba melina melinda melisa melissa melita melito
mellisa mellissa melodie melonie melton melva melvin melvina melvyn menachem mendy meredith merima merimo merle
merlene merlin merlyn merri merrill merritt merve mervin meryl metka metko mette mia miah micaela micah michael
michaela michal michale michał micheal michel michele michell michelle mickey mickie micky migdalia miguel miha
mihael mihaela mihaele mihaelo mihai mihajlo miho mihovil mihovile mijo mikael mikaela mikala mikayla mike mikel
mila milagros milan milane mildred milena mileno miles milford milica milice milico milissa milivoj milivoju
miljenko millard millicent millie milo milorad milorade milos milose milton milutin milutine mimi mina mindi mindy
minerva ming minh minji minjun minnie mio miodrag miodrage miranda mirela mirelo mireya miriam mirjana mirjano mirko
mirna mirno miro miroslav miroslave mirza mirzo misael misaki mislav mislave missy misti misty mitch mitchel
mitchell mitja mitjo mitzi miya mladen mladene mladenka mladenko mohamed mohammad mohammed mohit moira moises mojca
mojco mollie molly mona monica monika moniko monique monroe monserrat monte montgomery montrell monty morgan moriah
moritz morris morton mose moses moshe muhamed muhamede muhammad murat muriel murphy murray mustafa mya myah mykola
myles myra myranda myrna myron myrtis myrtle nabil nadia nadine najee nakia nakisha nan nanci nancie nancy nanette
nannette nannie naoki naoko naomi napoleon nash nasir natalee natalia natalie natalija natalijo nataly natalya
natasa natasha nataso nathalie nathaly nathan nathanael nathanial nathaniel nathen natosha naveen navid nayeli neal
nebojsa nebojso ned nediljko nedim nedime nedra neha nehemiah neil nejc nejce nejla nejlo nejra nejro nelda nell
nellie nelson nemanja nemanjo nenad nenade nermin nermine nestor nettie neva nevaeh neven nevena nevene nevenka
nevenko neveno newell newton neza nezo nia nichelle nichol nicholas nicholaus nichole nick nicki nicklaus nickolas
nicky nico nicola nicolas nicole nicolette nicolle nigel nik nika nikhil niki nikia nikita nikki nikko niklas niko
nikola nikolas nikole nikolina nikolino nikolo nikos nila niles nils nina nino nisha nita nitin noa noah noe noel
noelia noelle noemi nola nolan nona noo noor nora norah norbert norberto noreen norene norine norma norman normand
noro norris nour nuno nuria nusa nuso nya nyasia nyla obie octavia octavio odalys odell odessa odis ofelia ognjen
ognjene oksana ola ole oleg olen olena olga olin olive oliver olivera olivero olivia olivier ollie oma omar omari
omarion omer omere ona ondrej onur opal ophelia ora oralia oran oren orin orion orlando orrin orval orville oscar
oskar osman osmane osvaldo oswaldo otha otis ottis otto owen ozan ozana ozano ozlem ozren ozrene pablo paige palmer
paloma pam pamala pamela pamella pankaj paola paolo parisa parker parrish pasquale pat patrica patrice patricia
patrick patrik patsy patti pattie patty paul paula pauletta paulette paulina pauline paulo pavao pavel pavle paweł
paxton payton pearl pearlie pearline pedro peggie peggy penelope penni pennie penny percy perica perice perico perla
pernell perry petar petare pete peter petr petra petre petro peyton phil philip philipp philippe phillip phillis
phoebe phuong phylicia phylis phyllis pia pierce pierre pieter pietro pilar pio piotr piper polly polona polono
pooja porsha porter portia pradeep prakash pranav prashant predrag predrage preeti presley preston primoz primoze
priscilla priya priyanka prudence qiana qiang quang quentin quiana quincy quinn quinten quintin quinton rachael
racheal rachel rachelle racquel radha radmila radmilo radomir radomire radoslav radoslave radovan radovane rae
raegan raekwon rafael rafaele raffaella raheem rahsaan rahul raina raj rajesh rajiv rajka rajko rakeem rakesh ralf
ralph ramesh rami ramiro ramon ramona ramsey rand randal randall randel randell randi randle randolph randy rania
ranko raphael raquel rashaad rashad rashawn rasheed rashida rashmi rasmus ratko raul raven ravi ray rayburn rayford
raymon raymond raymundo rayna raynard reagan reanna reba rebeca rebecca rebeka rebekah rebeko reece reed reese
refugio regan regenia reggie regina reginal reginald regis reid reilly reina reinaldo reka rekha relja reljo
remington ren rena renae renaldo renata renato rene renea renee renita reta retha reuben reva rex rey reyes reyna
reynaldo reynold reza rhea rhett rhianna rhiannon rhoda rhonda rhys ricardo riccardo rich richard richelle richie
rick rickey ricki rickie ricky rico rigoberto rikki riley risa rita ritchie ritu riya rob robb robbie robbin robby
robert roberta roberto robin robyn rocco roce rochelle rocio rocky rod roddy roderick rodger rodney rodolfo rodrick
rodrigo roel rogelio roger rogers rohan rohit roko roland rolanda rolando rolf rolland rollie rollin roma romain
roman romeo romona ron rona ronald ronaldo ronan ronda roni ronna ronnie ronny roosevelt rory rosa rosalee rosalie
rosalind rosalinda rosalyn rosann rosanna rosanne rosario roscoe rose roseann roseanna roseanne rosella roselyn
rosemarie rosemary rosendo rosetta rosevelt rosie rosita roslyn ross rowan rowena rowland roxana roxane roxann
roxanna roxanne roxie roy royce ruben rubi rubin rubye rudolph rudy rufus rui rupert russ russel russell rusty ruth
ruthann ruthanne ruthie ruud ruzica ruzice ruzico ryan ryann ryder ryker rylan ryland rylee ryleigh rylie ryne ryota
saad sabina sabine sabino sabrina sachin sade sadie safet safete saige sakshi sakura sal salina sallie sally salma
salvador salvatore sam samantha samara samatha sameer sami samir samire sammie sammy samson samuel sana sanaa
sandeep sander sandi sandra sandrine sandro sandy sanel sanele sanford saniya saniyah sanja sanjay sanjeev sanjo
sanjuanita sanne santana santiago santino santos sara sarah sarahi sarai sariah sarina saro sasa sasha saso satoshi
saul saundra saurabh savana savanah savanna savannah savion sawyer scarlett schuyler scot scott scottie scotty sead
seade seamus sean sebastian sebastien sedrick sejla sejlo selena selina selma selmo sem semaj senad senade seneca
senka senko seo seojun seoyeon serena sergey sergio serkan seth seymour shad shaina shakira shalini shalonda shamar
shameka shamika shana shanae shanda shane shanell shani shania shanice shanika shaniqua shanita shaniya shanna
shannan shannon shanon shanta shante shantel shantell shaquan shaquille shara sharen shari sharla sharlene sharon
sharonda sharron sharyn shashank shaun shauna shavon shavonne shawanda shawn shawna shawnda shay shayla shaylee
shayna shayne shea sheena sheila shelbi shelbie shelby sheldon shelia shelley shelli shellie shelly shelton shemar
sheree sheri sheridan sherie sherilyn sherita sherlyn sherman sheron sherri sherrie sherrill sherron sherry sherryl
sherwood sheryl shiela shirlee shirlene shirley shon shonda shonna shota shreya shreyas shruti shyann shyanne
siddharth sidney sienna sigrid silas silke silvia silvija silvijo silvio sime simeon simon simona simone simono
simun simune sinisa siniso siobhan sita skip skyla skylar skyler slaven slavene slavica slavice slavico slavko
slađana slađano slobodan slobodane smiljana smiljano sneha snezana snezano snjezana snjezano socorro sofia sofija
sofijo solomon sommer sonal sondra sonia sonja sonjo sonny sonya soo sophia sophie sora soren sota spela spelo
spencer spenser spomenka spomenko srecko srinivas srđan srđane stacey staci stacia stacie stacy stan stana stanford
stanley stano stanton starla stefan stefane stefani stefanie stefano stefica stefice stefico stella stephan stephane
stephanie stephany stephen stephenie stephon stetson stevan steve steven stevie stewart stipe stjepan stjepane
stoney strahinja strahinjo stuart sue suellen sullivan sumeja sumejo sumit suncana suncano sunil sunita sunny suresh
susan susana susann susanna susannah susanne susie suzan suzana suzann suzanna suzanne suzano suzette suzie suzy
sven svetlana svetlano swati sybil syble sydnee sydni sydnie syed sylvester sylvia sylvie syreeta søren tabatha
tabetha tabitha tad tadej tadeja tadejo tadeju takashi takeshi takisha takumi talia taliyah talmadge talon tamala
tamara tamaro tamatha tameka tamela tamera tami tamia tamica tamie tamika tamiko tammi tammie tammy tamra tana
tanesha tangela tania tanika tanisha taniya taniyah tanja tanjo tanner tanvi tanya tara tarah taras tarek tarice
tarik tariq tarsha tarun taryn tasha tate tatiana tatianna tatjana tatjano tatum tatyana taurean tavares tavon
tawana tawanda tawanna tawny tawnya taya tayler taylor tea teagan ted teddy teena tena tenisha teno teo teodora
teodoro tera terence teresa terese teressa tereza terezo teri terra terrance terrell terrence terri terrie terrill
terry tess tessa tevin tex thad thaddeus thalia thanh thea theadore theda thelma theo theodora theodore theresa
therese theron thierry thomas thor thorsten thurman tia tiago tiana tianna tiara tiera tierra tiffani tiffanie
tiffany tihana tihano tihomir tihomire tijana tijano tilen tilene till tim timmie timmothy timmy timo timothy tin
tina tine tino tio tisha titus tjasa tjaso tobias tobin toby tod todd tolga tom toma tomas tomasz tomaz tomaze
tomeka tomika tomislav tomislave tommaso tommie tommy tomo toncica toncice toncico toney toni tonia tonja tony tonya
torey tori torrance torrence torrey torsten tory tose tosha toya tracee tracey traci tracie tracy trae trang travon
tremaine tremayne trena trent trenton tresa tressa treva trever trevin trevion trevon trevor trey treyvon tricia
trina trisha trista tristan tristen tristian tristin triston troy trudy truman trystan tuan tucker turner tvrtko
twila twyla tyesha tyler tylor tyquan tyra tyree tyrel tyrell tyrese tyron tyrone tyshawn tyson ulises ulrike
ulysses una uno urban urbane urh urhe uriah uriel uros urose urska ursko ursula usha usman ute uwe vada val valarie
valentin valentina valentine valentino valeria valerie valorie van vance vanesa vaneso vanessa vanja vanjo varun
vasyl vaughn veda vedad vedade vedran vedrana vedrane vedrano velda velimir velimire veljko velma venessa venita
venkat vera verda verica verice verico verla verlin vern verna verne vernell vernice vernon vero veronica vesna
vesno vic vice vicente vickey vicki vickie vicky victor victoria vid vida vide vidya vijay vikas vikki vikram viktor
viktore viktorija viktorijo vinay vince vincent vincenzo vinka vinko vinson viola violet virgie virgil virginie
visnja visnjo vita vito vivek vivian viviana vjekoslav vjekoslave vladimir vladimire vlado vlasta vlasto vlatko
volkan volker von vonda vonnie vuce vuk wade walid walker wallace wally walt walter walton wanda ward wardell warner
warren wayland waylon waymon wayne wei weldon wendell wendi wendy werner wes wesley westley weston whitley whitney
wilber wilbert wilbur wilburn wilda wiley wilford wilfred wilfredo wilhelmina will willa willam willard willia
william williams willian willie willis willow wilma wilmer wilson wilton windell winfield winford winfred winifred
winnie winona winston wojciech wolfgang woodrow woody wyatt wylie wyman xander xavier xiaoli xiaoming ximena xin
xiomara xzavier yadira yahir yair yajaira yan yancy yannis yareli yaritza yash yasmeen yasmin yasmine yazmin yesenia
yessenia ying yolanda yolonda yosef yoselin youssef yu yui yuki yuko yuliana yumi yuri yusuf yuta yves yvette yvonne
zachariah zachary zachery zack zackary zackery zahra zain zainab zaire zakary zala zalo zan zander zane zaria zariah
zarko zavier zayne zdenka zdenko zdravko zechariah zelda zeljana zeljano zeljka zeljko zella zelma zerina zerino
zeynep zhiwei ziad ziga zigo zika ziko zina zion ziva zivko zivo zlata zlatan zlatane zlatica zlatice zlatico zlatko
zoe zoey zoie zoltan zora zoran zorana zorane zorano zorica zorice zorico zoro zrinka zrinko zsofia zuzana zuzanna
zvone zvonimir zvonimire đorđe đuro đurđica đurđice đurđico łukasz
`
    .trim()
    .split(/\s+/)
)
