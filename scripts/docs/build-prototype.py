"""Generate the prototype overview from verified local artifacts."""
from pathlib import Path
import json
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.utils import ImageReader
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, Image, Flowable, Preformatted

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'output/pdf/Prototype.pdf'
RUN = ROOT / 'work/ml/training-runs/bge-full-20261103T093751720940Z-bdc36df2'
ready = json.loads((RUN / 'ready-model.json').read_text())
NAVY = colors.HexColor('#172F46')
ACCENT = colors.HexColor('#466A88')
MUTED = colors.HexColor('#526572')
LIGHT = colors.HexColor('#EDF3F6')
LINE = colors.HexColor('#D7E1E8')
WIDTH = 487
styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name='BodyTextCustom', fontName='Helvetica', fontSize=10, leading=15, textColor=NAVY, spaceAfter=10))
styles.add(ParagraphStyle(name='SmallCustom', fontName='Helvetica', fontSize=8.4, leading=12, textColor=MUTED, spaceAfter=8))
styles.add(ParagraphStyle(name='TableCustom', fontName='Helvetica', fontSize=9, leading=12, textColor=NAVY))
styles.add(ParagraphStyle(name='TableHeadCustom', fontName='Helvetica-Bold', fontSize=9, leading=12, textColor=colors.white))
styles.add(ParagraphStyle(name='TitleCustom', fontName='Helvetica-Bold', fontSize=29, leading=34, textColor=NAVY, spaceAfter=16))
styles.add(ParagraphStyle(name='H2Custom', fontName='Helvetica-Bold', fontSize=12, leading=16, textColor=ACCENT, spaceBefore=11, spaceAfter=7))
styles.add(ParagraphStyle(name='KickerCustom', fontName='Helvetica-Bold', fontSize=8, leading=12, textColor=ACCENT, spaceAfter=13))
styles.add(ParagraphStyle(name='CodeCustom', fontName='Courier', fontSize=8.8, leading=12.5, textColor=NAVY))
story = []


def p(text, style='BodyTextCustom'):
    return Paragraph(escape(text).replace('\n', '<br/>'), styles[style])


def body(text): story.append(p(text))
def sub(title, text): story.extend([p(title, 'H2Custom'), p(text)])
def code(text):
    panel = Table([[Preformatted(text, styles['CodeCustom'])]], colWidths=[WIDTH])
    panel.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),LIGHT),('LEFTPADDING',(0,0),(-1,-1),12),('TOPPADDING',(0,0),(-1,-1),10),('BOTTOMPADDING',(0,0),(-1,-1),10)]))
    story.extend([panel, Spacer(1,12)])


def chapter(number, title, subtitle):
    if story: story.append(PageBreak())
    story.extend([p(f'RESEARCH ATLAS  /  {number:02d}', 'KickerCustom'), p(title, 'TitleCustom'), p(subtitle, 'SmallCustom'), Spacer(1, 8)])


def table(headers, rows, widths):
    content = [[p(v, 'TableHeadCustom') for v in headers]] + [[p(str(v), 'TableCustom') for v in row] for row in rows]
    t = Table(content, colWidths=widths, hAlign='LEFT', repeatRows=1)
    t.setStyle(TableStyle([
        ('BACKGROUND',(0,0),(-1,0),NAVY),('VALIGN',(0,0),(-1,-1),'TOP'),
        ('LEFTPADDING',(0,0),(-1,-1),9),('RIGHTPADDING',(0,0),(-1,-1),9),
        ('TOPPADDING',(0,0),(-1,-1),8),('BOTTOMPADDING',(0,0),(-1,-1),8),
        ('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,LIGHT]),
        ('LINEBELOW',(0,-1),(-1,-1),.5,LINE)]))
    story.extend([t,Spacer(1,12)])


class Architecture(Flowable):
    def __init__(self):
        super().__init__()
        self.width = WIDTH
        self.height = 207
    def draw(self):
        c=self.canv
        def box(x,y,w,h,title,lines):
            c.setFillColor(LIGHT); c.roundRect(x,y,w,h,7,fill=1,stroke=0)
            c.setFillColor(NAVY); c.setFont('Helvetica-Bold',10); c.drawString(x+12,y+h-20,title)
            c.setFont('Helvetica',8.5)
            for i,line in enumerate(lines): c.drawString(x+12,y+h-35-i*12,line)
        def arrow(x,y,x2,y2):
            c.setStrokeColor(ACCENT); c.setLineWidth(1.2); c.line(x,y,x2,y2)
            if y==y2: c.line(x2,y2,x2-5,y2+3); c.line(x2,y2,x2-5,y2-3)
            else: c.line(x2,y2,x2-3,y2+5); c.line(x2,y2,x2+3,y2+5)
        box(0,126,140,70,'Browser',['React + Vite','Manual search / Paper Trail'])
        box(170,126,145,70,'Express API',['Request validation','Records + researcher ranking'])
        box(345,126,142,70,'MongoDB',['134 researchers','7,283 publications'])
        box(170,18,145,78,'Private model API',['FastAPI + PyTorch','One query -> one vector','No MongoDB access'])
        box(345,18,142,78,'Verified bundle',['Fine-tuned encoder','7,283 x 384 paper vectors','Metadata + integrity hashes'])
        arrow(140,163,170,163); arrow(315,163,345,163)
        arrow(243,126,243,96); arrow(315,57,345,57)


def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(LINE); canvas.line(54,43,541,43)
    canvas.setFillColor(MUTED); canvas.setFont('Helvetica',8)
    canvas.drawString(54,29,'RESEARCH ATLAS  |  Prototype overview  |  4 November 2026')
    canvas.drawRightString(541,29,str(doc.page))
    canvas.restoreState()


chapter(1,'Research Atlas','SUMMER RESEARCH SCHOLARSHIP  /  PROTOTYPE DOCUMENTATION')
body('A research discovery prototype that helps users explore University of Otago publications and identify researchers with related work. It combines a conventional search interface with neural paper retrieval and transparent publication evidence.')
table(['Collection','Neural representation','Current status'],[
    ['7,283 publications\n134 researchers\n8 academic units','BGE small English v1.5\n384 dimensions\n512-token input limit','Local end-to-end prototype\nFine-tuned model connected\nPaper Trail interface verified']], [155,166,166])
story.append(Spacer(1,5))
image_path=ROOT/'work/ui-qa/paper-trail-live.png'
if image_path.exists():
    iw,ih=ImageReader(str(image_path)).getSize()
    story.append(Image(str(image_path),width=WIDTH,height=WIDTH*ih/iw))
    story.append(p('Figure 1. Live Paper Trail recommendations for a software-testing query. Researcher cards expose the publications behind each suggestion.','SmallCustom'))
sub('Purpose and scope','Prepared by Sapta Sindhu for discussion with Dr. Yuan. This is a working local prototype, not a production service or a validated measure of supervisor suitability. Recommendations indicate research-topic fit; availability, funding, and supervision quality are not established.')
body('The following pages distinguish implemented functionality, measured proxy results, and future research work. The documentation reflects the verified local system as of 4 November 2026.')

chapter(2,'System architecture','Clear boundaries between the browser, public API, database, and model inference.')
story.append(Architecture())
sub('Two retrieval paths','Manual search stays in the Express application and uses deterministic lexical rules. The AI Recommendations button invokes a separate semantic retrieval path. The system does not blend these two rankings or replace the normal results.')
sub('Neural request lifecycle','The browser sends the committed query and filters to Express. Express asks the private model service for up to 100 paper candidates. It then reads the corresponding MongoDB records, verifies researcher links, reapplies live filters, and returns up to three researchers with up to three supporting papers each.')
sub('Offline preparation versus online inference','Data export, pair preparation, fine-tuning, evaluation, and full-corpus encoding are offline operations. Online inference loads a completed model/index bundle once and only encodes the incoming query. Search requests do not update model parameters.')
sub('Evidence, not generated prose','There is no generative chatbot or LLM explanation layer in this version. The recommendation reason is constructed from a retrieved publication title, and users can inspect the supporting abstract and source link.')

chapter(3,'Codebase and technologies','An npm workspace for application code, with an independent Python ML area.')
table(['Area','Implementation','Responsibility'],[
    ['Web application','React 19.3.1\nVite 8.3.5','Search, filters, dialogs, saved records, comparisons, and Paper Trail.'],
    ['Public API','Node.js 24.22.1\nExpress 5.3.0','Validation, public records, manual search, researcher aggregation.'],
    ['Persistence','MongoDB 8.2.12\nMongoose 9.11.2','Researcher/publication schemas, source IDs, verified author references.'],
    ['Neural model','Python 3.14.6\nPyTorch 2.15.0+cpu\nTransformers 5.22.1','Encoder training and inference; NumPy stores and scores vectors.'],
    ['Private inference','FastAPI 0.162.0\nUvicorn 0.54.0\nPydantic 2.14.2','Validated query contract and model-bundle readiness.']], [100,153,234])
code('apps/web/          UI, features, hooks, services, tests\napps/api/          routes, controllers, services, schemas, tests\npackages/search/   shared pure lexical search rules\nml/research_ml/    corpus, BM25 baseline, benchmark metrics\nml/notebooks/      interactive experiments\nml/tests/          baseline and neural-service checks\nscripts/           launch, verification, documentation tools\ndocs/              architecture and developer documentation\nwork/              ignored datasets, models, logs, QA artifacts')
body('Shared lexical helpers are imported through @research-atlas/search. The web app does not import database models or backend internals. Runtime datasets, checkpoints, and immutable training reports stay separate from application source. Historical run metadata remains unchanged after the folder reorganization.')

chapter(4,'Interface and API','The normal search experience remains available alongside neural recommendations.')
sub('Discovery interface','Users can search names, research interests, publication text, and identifiers; filter by academic unit, researcher, year/range, and publication type; and switch between researcher and publication results. URL state supports refresh and browser navigation. Saves remain in local storage; comparisons support up to three researchers.')
sub('Approved design: Paper Trail','A compact AI Recommendations button opens a floating nonmodal shortlist. Selecting a researcher updates supporting papers; expanding a paper exposes its abstract and source. The existing publication dialog supplies full details. Loading, unavailable, empty, and retry states are implemented. Query/filter changes close stale recommendations and cancel obsolete requests.')
table(['Endpoint','Purpose'],[
    ['GET /api/discovery','Filtered, scored, paginated lexical results.'],
    ['GET /api/discovery/summary','Collection counts, departments, and years.'],
    ['GET /api/researchers[/:id]','Researcher list and individual profile.'],
    ['GET /api/publications[/:id]','Publication list and individual record.'],
    ['POST /api/recommendations','Neural researcher shortlist and publication evidence.'],
    ['GET /api/recommendations/status','Whether the public adapter is configured as enabled.'],
    ['Private GET /health; POST /search','Model readiness and filtered paper-vector retrieval.']], [233,254])
body('Recommendation queries accept 1-160 characters and structured filters. Invalid input returns HTTP 400 at the public API; disabled or unavailable inference returns 503. The private service is bound to loopback. The repository also exposes researcher/publication creation endpoints; ingestion and write operations are separate from recommendation requests.')
body('The interface supports keyboard dismissal, focus restoration, mobile layouts, and reduced motion. A clearly labelled sample mode uses fictional local records solely to demonstrate layout.')

chapter(5,'Data and conventional search','Source identity and author linkage are as important as vector similarity.')
table(['Entity','Key fields and relationships'],[
    ['Researcher','Name, biography, affiliations, research interests, profile URL; ORCID/OpenAlex and optional source IDs.'],
    ['Publication','Title, abstract, keywords, venue, type, year/date, source URL, external IDs, and ordered authors.'],
    ['Author relationship','Each author retains a published name and optional researcherId reference. Unlinked coauthors remain unlinked; names alone do not establish identity.']], [112,375])
body('The saved corpus contains 7,283 papers; 5,470 have abstracts and 1,813 do not. Eight units are represented: School of Computing, Mathematics and Statistics, Biochemistry, Physics, Chemistry, Microbiology and Immunology, Geology, and Zoology. Counts describe this collection, not complete researcher careers.')
sub('Ingestion and provenance','Tools stage official profile evidence, match researcher identities to OpenAlex, import eligible publications, and optionally enrich missing fields through Crossref. Source IDs, source order, snapshots, and audit logs are preserved. Ambiguous matches are left for review. Source abstracts and metadata are not assumed to have uniform reuse rights.')
sub('Manual search','Queries use literal case-insensitive matching, all/any terms, quoted phrases, and exact DOI/ORCID/OpenAlex lookup. Field weights prioritize names and research interests for profiles, and titles/keywords for papers. Results are filtered, scored, conservatively grouped, ranked over the complete candidate set, then paginated. A 10,000-candidate guard rejects overly broad requests.')
sub('Separate benchmark baseline','The Python benchmark uses an independent BM25 implementation, exact-identifier controls, and ranking metrics. It is not the production lexical scorer. Topic relevance judgments remain pending; unjudged documents are not silently treated as irrelevant. The starter benchmark contains 33 queries: 17 identifier controls and 16 unjudged topical queries.')

chapter(6,'The neural text encoder','BGE means BAAI General Embedding; the selected base is bge-small-en-v1.5.')
body('The encoder is a bidirectional BERT-family Transformer already trained for useful text embeddings. Fine-tuning adapts its representations to weak paper-title/content associations. It is not trained from random initialization.')
table(['Stage','What happens'],[
    ['Tokenization','WordPiece converts text into token IDs and inserts special tokens such as [CLS] and [SEP]. Padding has an attention mask.'],
    ['Input vectors','Token, learned absolute position, and token-type embeddings are added. LayerNorm and dropout form the input to the Transformer.'],
    ['Contextual encoding','12 Transformer blocks, 12 attention heads per block, hidden size 384. Each head has 32 dimensions. Feed-forward size is 1,536, with GELU activation.'],
    ['Text embedding','Take the final [CLS] hidden vector and L2-normalize it. The unused BERT pooler is not the retrieval embedding.']], [112,375])
code('X_i = E[token_id_i] + P[position_i] + T[type_i]\nQ = X W_Q       K = X W_K       V = X W_V\nA = softmax(Q K^T / sqrt(d_head) + attention_mask)\nHead output = A V\nz = h_[CLS] / ||h_[CLS]||_2')
body('Attention combines value vectors using learned query-key compatibility scores. Head outputs pass through output projections, residual connections, LayerNorm, and feed-forward blocks. Softmax supplies attention weights; GELU supplies the feed-forward nonlinearity. A high attention score is not itself proof of useful or causal evidence.')
body('All tokens retain contextual hidden vectors. Selecting [CLS] does not physically merge or delete the other tokens. At most 512 tokens are encoded; 464 indexed papers were truncated, and that loss of content is recorded. Full paper bodies are not part of Version 1.')

chapter(7,'Fine-tuning with contrastive loss','Two independent text passes through one shared encoder; no query-paper cross-attention.')
body('A paper title acts as a proxy query. Its keywords plus available abstract form the positive document, with the leading title removed. Other papers in the batch are assumed negatives. Titles are weak labels for content association, not human judgments of a user information need.')
code('Title q_i  -> shared encoder f_theta -> normalized z_qi\nContent d_j -> shared encoder f_theta -> normalized z_dj\n\nS_ij = (z_qi dot z_dj) / temperature\nL = -(1/B) sum_i log[exp(S_ii) / sum_j exp(S_ij)]')
body('The contrastive softmax operates across candidate-document scores. It is different from token-level attention softmax inside the encoder. Title tokens do not attend directly to abstract tokens in this bi-encoder. Gradients flow through both encoding branches into the same shared parameters, including token/position tables, Q/K/V projections, and feed-forward layers.')
table(['Training choice','Implementation'],[
    ['Data partition','4,354 training pairs; 538 validation and 538 proxy-test rows. Evaluation samples 531 and 528 unique groups respectively.'],
    ['Leakage screening','Exact duplicate groups stay in one split; known benchmark targets and heuristic cross-split near-title candidates are reserved. Semantic duplicates can remain.'],
    ['Optimization','AdamW; batch size 8 for full epochs; temperature 0.05; matrix weight decay 0.01; gradient-norm clipping at 1.'],
    ['Run sequence','10-step pilot, then two complete 545-step epochs. Learning rates 1e-5 then 5e-6; 1,100 optimizer steps in total.'],
    ['Trainable weights','33,212,160 parameters on the CLS path; unused pooler frozen. Each full epoch covers all 4,354 pairs once.']], [112,375])
body('Checkpoint choice uses validation cross-entropy before the held-out test is opened. More epochs are not automatically better. Related documents can be false negatives, and weak-label training can favor title/content matching over real research questions.')

chapter(8,'Evaluation and verification','Promising proxy results, with an explicit boundary around what they establish.')
table(['Evaluation','Before','After'],[
    ['Second epoch validation\n531 queries/candidates','Loss: 0.107924\nTop-1: 97.93%','Loss: 0.098597\nTop-1: 98.12%'],
    ['Held-out proxy test\n528 queries/candidates','Pretrained encoder\nLoss: 1.324713\nTop-1: 96.78%','Selected fine-tuned encoder\nLoss: 0.115707\nTop-1: 98.30%']], [177,155,155])
body('Top-1 asks whether a title retrieves its own paper content first within the fixed evaluation pool. The held-out result is an improvement of about 1.52 percentage points. It does not measure full-corpus query relevance, calibrated confidence, or the suitability of a researcher as a supervisor. Test results were not used to select another checkpoint.')
sub('Reproducibility and model integrity','Training logs record batch IDs, losses, gradient norms, settings, script hashes, and source fingerprints. Checks verify complete epoch coverage and observed E/P/Q/K/V updates. Reloaded checkpoint vectors match saved references. The deployed bundle records file hashes, normalization, tokenizer, and model/corpus fingerprints.')
table(['Verification','Observed outcome'],[
    ['JavaScript regression suite','89 tests passed across shared search, web state, API, models, and ingestion rules.'],
    ['Python suites','20 offline benchmark tests and 5 neural-service/finalization tests passed.'],
    ['Application build','Vite production build passed; main chunk remains above its 500 kB advisory.'],
    ['Local integration','Real inference, MongoDB author links, department/year filters, empty/invalid requests, and ordinary search verified.'],
    ['Browser workflow','Live AI panel, researcher selection, abstract expansion, existing paper dialog, close/reopen; earlier mobile and keyboard checks passed.']], [155,332])
body('Live checks used software testing and protein structure queries, including a Biochemistry filter from 2020. These are functional integration checks, not a representative user study or latency benchmark.')

chapter(9,'Serving and demonstration','One model space for both query and paper vectors.')
body('The selected checkpoint re-encodes each paper using title + keywords + available abstract. This creates a normalized 7,283 x 384 matrix, plus source IDs and metadata. Query vectors from the fine-tuned model must never be compared against the older pretrained index.')
code('query -> normalized embedding\n      -> filtered paper vectors -> cosine similarity\n      -> top 100 paper candidates\n      -> verified MongoDB author links + live filters\n      -> mean of up to 3 best papers per researcher\n      -> top 3 researchers + supporting papers')
body('Vector search uses an exact NumPy dot product over eligible rows at the current scale, not an approximate vector database. The capped researcher score limits publication-volume effects but remains a heuristic. There is no calibrated cutoff guaranteeing that an unrelated query will receive no suggestions.')
sub('Local startup','Start the existing MongoDB instance, then use scripts/start-neural.ps1 with the completed run ready-model.json. It verifies the bundle/model identity, checks MongoDB, and launches the private model API and Express adapter. The AI flag applies to child processes; the stored .env remains disabled by default. The web workspace starts separately.')
sub('Suggested demonstration','Search for software testing, inspect the ordinary results, then open AI Recommendations. Select a researcher, expand a supporting paper, and open its details. Repeat with protein structure and a Biochemistry filter. Explain that the shortlist is grounded in retrieved publications, rather than a claim about availability or supervision quality.')
table(['Local service','Address'],[
    ['Demonstration web app','http://127.0.0.1:5174/'],
    ['Public API','http://127.0.0.1:5000/api'],
    ['Private model health','http://127.0.0.1:8100/health'],
    ['Progress dashboard','http://127.0.0.1:8766/']], [155,332])
body('This is a local demonstration configuration. Public deployment would require authentication and authorization design, controlled write endpoints, rate limiting, operational monitoring, and deployment hardening. These have not been established by the current tests.')

chapter(10,'Limits and research roadmap','Version 2 priorities should be chosen through controlled evaluation.')
sub('Current limitations','The corpus is incomplete, some papers lack abstracts, and long inputs are truncated. Snapshot filters can become stale as database records change. Weak title/content labels and incomplete semantic-duplicate screening limit evaluation claims. Researcher aggregation uses only retrieved candidates and verified links; no student preferences, supervision availability, or funding data are modeled.')
sub('Agreed Version 2: field weighting and full text','Encode title and abstract separately and evaluate explicit weighting. Add section/chunk retrieval when full text and appropriate access rights are available. Compare title-only, combined text, separate-field scores, and chunk-based retrieval on fixed judged queries. Concatenation in Version 1 does not imply equal field influence or fixed attention percentages.')
sub('Additional experiments','Collect human relevance judgments for real information needs; evaluate Recall@k, MRR, and nDCG with known judgment coverage. Investigate carefully selected hard negatives, a cross-encoder reranker, and a calibrated no-match decision. Measure inference latency and retrieval quality before selecting approximate indexing or larger models.')
sub('Prototype contribution','The current system demonstrates a complete path from sourced researcher/publication records to a usable discovery interface, a reproducible bi-encoder experiment, and a live evidence-backed recommendation panel. It provides a base for testing research questions, rather than a final claim of optimal recommendations.')
story.append(p('References and implementation evidence','H2Custom'))
refs=[
    ('BAAI, bge-small-en-v1.5 model card','https://huggingface.co/BAAI/bge-small-en-v1.5'),
    ('Sentence Transformers, MultipleNegativesRankingLoss','https://www.sbert.net/docs/package_reference/sentence_transformer/losses.html'),
    ('Vaswani et al., Attention Is All You Need (2017)','https://arxiv.org/abs/1706.03762'),
]
for label,url in refs:
    story.append(Paragraph(f'{escape(label)}<br/><link href="{url}" color="#466A88">{escape(url)}</link>',styles['SmallCustom']))
story.append(p('Local evidence: encoder/config.json; the two completed full-epoch reports; heldout-proxy-report.json; bundle manifest.json; ready-model.json; live-connection.json; repository tests and browser QA artifacts. Numeric results in this report come from these local artifacts, not external benchmark claims.','SmallCustom'))
OUT.parent.mkdir(parents=True,exist_ok=True)
doc=SimpleDocTemplate(str(OUT),pagesize=(595.28,841.89),leftMargin=54,rightMargin=54,topMargin=48,bottomMargin=60,
                      title='Research Atlas - Prototype Documentation',author='Sapta Sindhu',subject='System overview, architecture, and neural retrieval prototype')
doc.build(story,onFirstPage=footer,onLaterPages=footer)
print(OUT)
