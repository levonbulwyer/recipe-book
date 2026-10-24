import sqlite3, json, os
db=os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','recipes.db')
if os.path.exists(db): os.remove(db)
con=sqlite3.connect(db); con.execute('PRAGMA foreign_keys=ON')
con.executescript(open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'schema.sql')).read())
# master ingredients: name, aisle, default unit, density, staple, aliases
M=[('Brown lentils (dried)','Pantry','g',0.8,0,'lentils,dried lentils'),('Kumara','Produce','g',None,0,'sweet potato'),
('Olive oil','Pantry','mL',0.92,1,'EVOO,extra virgin olive oil'),('Salt','Pantry','tsp',None,1,''),('Black pepper','Pantry','tsp',None,1,'pepper,ground black pepper'),
('Onion','Produce','each',None,1,'brown onion'),('Shiitake mushrooms','Produce','g',None,0,'portobello mushrooms,mushrooms'),
('Garlic','Produce','each',None,1,'garlic cloves'),('Rosemary','Produce','each',None,0,''),('Walnuts','Pantry','g',0.4,0,'raw walnuts'),
('Sunflower seeds','Pantry','g',0.56,0,'raw sunflower seeds'),('Rolled oats','Pantry','g',0.35,1,'oats'),('Tomato paste','Pantry','tbsp',None,0,'tomato puree'),
('Miso paste','Pantry','tbsp',None,0,'miso'),('Vegetable stock powder','Pantry','tsp',None,0,'stock powder'),('Tamari','Pantry','tbsp',None,0,'soy sauce'),
('Kelp powder','Pantry','tsp',None,0,''),('Tomato sauce','Pantry','mL',None,1,'ketchup'),('BBQ sauce','Pantry','mL',None,0,'barbecue sauce'),
('Malt vinegar','Pantry','tbsp',None,0,''),('Brown sugar','Pantry','tbsp',0.85,1,''),('Plain flour','Baking','g',0.53,1,'flour'),
('Caster sugar','Baking','g',0.85,1,'sugar'),('Baking powder','Baking','tsp',None,1,''),('Milk','Dairy','mL',1.03,1,''),('Egg','Dairy','each',None,1,'eggs'),('Butter','Dairy','g',0.96,1,'')]
con.executemany('INSERT INTO ingredient(name,aisle,default_unit,density_g_ml,is_staple,aliases) VALUES (?,?,?,?,?,?)',[(a,b,c,d,e,f) for a,b,c,d,e,f in M])
iid={n:i for i,n in con.execute('SELECT id,name FROM ingredient')}
D={'g':'g','ml':'mL','spoon':None,'count':'each','pinch':'pinch','text':None}
def load(title,meta,ing,steps,labels):
    cur=con.execute('INSERT INTO recipe(title,source,page,cuisine,type,base_servings,prep_min,cook_min,notes) VALUES (?,?,?,?,?,?,?,?,?)',meta)
    rid=cur.lastrowid
    for l in labels: con.execute('INSERT INTO recipe_label VALUES (?,?)',(rid,l))
    ri={}
    for pos,(key,(master,k,a,unit,noun,disp,note,est,fixed)) in enumerate(ing.items(),1):
        u=unit or D[k]
        c=con.execute('INSERT INTO recipe_ingredient(recipe_id,key,ingredient_id,display_name,amount,unit,noun,scaling,estimated,note,position) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          (rid,key,iid[master],disp,a,u,noun,'fixed' if fixed else 'linear',est,note,pos)); ri[key]=c.lastrowid
    S={}
    for pos,st in enumerate(steps,1):
        c=con.execute('INSERT INTO step(recipe_id,key,position,body,timer_text,continues) VALUES (?,?,?,?,?,?)',(rid,st['id'],pos,st['text'],st.get('timer'),1 if st.get('continues') else 0))
        S[st['id']]=c.lastrowid
        for u in st.get('uses',[]): con.execute('INSERT INTO step_uses VALUES (?,?)',(S[st['id']],ri[u]))
        for j,f in enumerate(st.get('from',[]),1): con.execute('INSERT INTO step_from VALUES (?,?,?)',(S[st['id']],S[f],j))
    return rid
# (master, kind, amount, unit, noun, display, note, estimated, fixed)
E={'lentils':('Brown lentils (dried)','g',100,None,None,'dried brown lentils','or 1 x 400 g can',1,0),
'kumara':('Kumara','g',450,None,None,'kumara','peeled, cut into 3 cm chunks',0,0),
'oil':('Olive oil','text',None,None,None,'olive oil','a drizzle',0,0),'sp':('Salt','text',None,None,None,'salt and pepper','to season',0,0),
'evoo':('Olive oil','ml',60,None,None,'extra virgin olive oil',None,0,0),'onion':('Onion','count',1,None,None,'large onion','chopped',0,0),
'mush':('Shiitake mushrooms','g',300,None,None,'shiitake or portobello mushrooms','roughly chopped',0,0),
'garlic':('Garlic','count',4,None,'cloves','garlic','crushed',0,0),'rosemary':('Rosemary','count',1,None,'stalk','rosemary','leaves very finely chopped',0,0),
'pinch':('Salt','pinch',1,None,None,'salt',None,0,1),'walnuts':('Walnuts','g',100,None,None,'raw walnuts',None,1,0),
'seeds':('Sunflower seeds','g',140,None,None,'raw sunflower seeds',None,1,0),'oats':('Rolled oats','g',45,None,None,'rolled oats','or breadcrumbs',1,0),
'paste':('Tomato paste','spoon',5,'tbsp',None,'tomato paste',None,0,0),'miso':('Miso paste','spoon',1,'tbsp',None,'miso paste','or 1 tsp Vegemite or Marmite',0,0),
'stock':('Vegetable stock powder','spoon',2,'tsp',None,'vegetable stock powder',None,0,0),'tamari':('Tamari','spoon',1,'tbsp',None,'tamari','or soy sauce',0,0),
'salt':('Salt','spoon',1.5,'tsp',None,'salt',None,0,0),'pepper':('Black pepper','spoon',1,'tsp',None,'finely ground black pepper',None,0,0),
'kelp':('Kelp powder','spoon',0.5,'tsp',None,'kelp powder','optional',0,0),'tsauce':('Tomato sauce','ml',60,None,None,'tomato sauce',None,0,0),
'bbq':('BBQ sauce','ml',60,None,None,'BBQ sauce','or extra tomato sauce',0,0),'vinegar':('Malt vinegar','spoon',2,'tbsp',None,'malt vinegar',None,0,0),
'sugar':('Brown sugar','spoon',2,'tbsp',None,'brown sugar',None,0,0)}
T=[{'id':'oven','text':'Heat the oven to 180°C fan-bake (190°C regular bake). Line a baking tray with baking paper.'},
{'id':'lentils','uses':['lentils'],'text':'Rinse the lentils and simmer in plenty of salted water until tender, then drain. Canned lentils only need draining.','timer':'25 min'},
{'id':'kumara','uses':['kumara','oil','sp'],'text':'Arrange the kumara on a baking tray, drizzle with oil, season and toss. Cover with foil and roast until tender.','timer':'25 min'},
{'id':'onion','uses':['evoo','onion'],'text':'Heat the oil in a large frying pan or flameproof casserole over medium heat. Cook the onion, stirring now and then, until soft and gooey.','timer':'10 min'},
{'id':'mush','uses':['mush','garlic','rosemary','pinch'],'from':['onion'],'text':'Add to the pan and cook, stirring, until the veges have reduced right down and the mushrooms are tender. Leave to cool slightly.','timer':'10 min'},
{'id':'nuts','uses':['walnuts','seeds'],'text':'Pulse in a large food processor to a chunky crumb.'},
{'id':'dry','uses':['oats','paste','miso','stock','tamari','salt','pepper','kelp'],'from':['nuts'],'text':'Tip the crumb into a large mixing bowl, add everything beside this box (kelp only if using) and stir to combine.'},
{'id':'mix','from':['lentils','kumara','mush','dry'],'text':'Tip the lentils, kumara and mushroom mixture into the food processor and pulse until slightly chunky: not a paste, but enough to stick together. Scrape down a couple of times. Add to the bowl and scrunch with your hands until evenly mixed.'},
{'id':'glaze','uses':['tsauce','bbq','vinegar','sugar'],'text':'Glaze: stir together in a small bowl.'},
{'id':'press','continues':1,'from':['mix','glaze'],'text':'Press the mixture into a loaf tin and smooth the top. Brush the glaze generously over the top.'},
{'id':'bake','continues':1,'from':['press'],'text':'Bake, glazing again once or twice during cooking.','timer':'50 min'},
{'id':'cool','continues':1,'from':['bake'],'text':'Cool in the tin, then slice very gently with a sharp knife. It slices more easily when cooler.','timer':'15 to 20 min'},
{'id':'store','continues':1,'from':['cool'],'text':'To store, seal well and keep in the fridge. Reheat at 170°C for about 20 minutes.'}]
load('Eatloaf',('Eatloaf','Supergood','64',None,'Dinner',10,60,45,'Page header says 45 min cook but the bake step says 50. Gluten-free: check oats, paste, miso, stock, soy, BBQ and tomato sauce; use apple cider vinegar for malt vinegar. Dried shiitake: 80 g soaked.'),E,T,['Supergood','Long','Plant-based'])
PE={'flour':('Plain flour','g',200,None,None,'plain flour',None,1,0),'sugar':('Caster sugar','g',15,None,None,'caster sugar',None,1,0),
'bp':('Baking powder','spoon',2,'tsp',None,'baking powder',None,0,1),'salt':('Salt','pinch',1,None,None,'salt',None,0,1),
'egg':('Egg','count',1,None,None,'egg',None,0,0),'milk':('Milk','ml',250,None,None,'milk',None,0,0),'butter':('Butter','g',30,None,None,'butter','melted',1,0)}
PT=[{'id':'dry','uses':['flour','sugar','bp','salt'],'text':'Whisk together in a large bowl.'},{'id':'wet','uses':['egg','milk','butter'],'text':'Beat together until smooth.'},
{'id':'batter','from':['dry','wet'],'text':'Pour the wet mixture into the dry mixture and stir until just combined.'},
{'id':'rest','continues':1,'from':['batter'],'text':'Rest the batter while the pan heats.','timer':'5 min'},
{'id':'cook','continues':1,'from':['rest'],'text':'Cook spoonfuls in a non-stick pan over medium heat until bubbles form, then flip.','timer':'2 to 3 min each side'},
{'id':'keep','continues':1,'from':['cook'],'text':'Keep the first batch warm in a low oven while you finish the rest.'}]
load('Pancakes',('Pancakes','Own recipe',None,None,'Breakfast',4,10,15,None),PE,PT,['Own recipe','Quick','Baking'])
con.commit(); con.close()
