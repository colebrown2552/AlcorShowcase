"""Load the Mental Health Austin JSON data into the configured database.

Reads the three *FinalConnections.json files under backend/data/connections,
reshapes them into ORM rows and inserts them. Run through seed.py, or directly
with ``python upload_data.py``. The target database is ``DATABASE_URL``
(SQLite file by default).
"""
import sqlalchemy as sqla
import sqlalchemy.orm as orm
# from sqlalchemy.orm import DeclarativeBase

import orm_classes as oc
import copy

import json

import pprint
import random
import sys
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / 'data' / 'connections'

def get_all_disorders():
    """Debug helper: print every Disorder row."""
    print('\nGetting all disorders\n')
    # num_disorders = request.args.get('num_disorders')
    all_disorders = oc.session.query(oc.Disorder.Disorder).all()
    print('\nGot All Disorders \n')
    print(f'\n{[vars(x) for x in all_disorders]}\n')
    # print(all_disorders)

def print_all_tables():
    """Print the names of the tables that exist in the database."""
    l = sqla.inspect(oc.engine).get_table_names()
    print(f'all the tables: {l}')

def clean_disorders():
    """Load the raw disorder records from disorderFinalConnections.json."""
    with open(DATA_DIR / 'disorderFinalConnections.json', 'r', encoding='utf-8') as f:
        disorders = json.load(f)
    # pprint.pprint(disorders)
    return disorders

def clean_locations():
    """Load the raw location records from locationFinalConnections.json."""
    with open(DATA_DIR / 'locationFinalConnections.json', 'r', encoding='utf-8') as f:
        r = json.load(f)
    return r

def clean_treatments():
    """Load the raw treatment records from treatmentFinalConnections.json."""
    with open(DATA_DIR / 'treatmentFinalConnections.json', 'r', encoding='utf-8') as f:
        r = json.load(f)
    return r

def get_disorders_list(disorders):
    """Flatten raw disorder records into dicts matching the Disorder columns."""
    l = []
    for disorder in disorders:
        cur = {}
        for i in disorder.items():
            cur["name"] = i[0]
            attrs = i[1]
            for attr_name, attr in attrs.items():
                # print(attr_name)
                if type(attr) == list or attr_name == 'Treatments':
                    # print('in if statement')
                    name = 'locations_list' if attr_name.lower() in 'locations_list' else 'treatments_list'
                    # print(f'{name}')
                    cur[name] = "~".join(attr)
                else:
                    if attr_name == 'Treatment':
                        name = 'treatment_attr'
                    else:
                        name = attr_name.lower().replace(' ', '_')
                    cur[name] = attr
        cur["population_affected"] = round(random.random() * (100 / 4), 2)
        # print(cur.keys())
        if len(l) and cur.keys() == l[-1].keys() or not len(l):
            l.append(cur)
    return l

def get_locations_list(locations):
    """Flatten raw location records into dicts matching the Location columns."""
    l = []
    for location in locations.items():
        cur = {}
        cur["name"] = location[0]
        for attr_name, attr in location[1].items():
            if type(attr) == list and attr_name != 'hours' and attr_name != 'photo_info':
                name = 'treatments_list' if attr_name.lower() in 'treatments_list' else 'disorders_list'
                # print(type(attr), type(name), type(attr[0]))
                # print(attr)
                cur[name] = "~".join(attr)
            elif attr_name == 'coordinates':
                cur["latitude"] = attr['location']['lat']
                cur['longitude'] = attr['location']['lng']
            elif attr_name == 'photo_info':
                # print(attr)
                html_link = attr[0]['html_attributions'][0]
                try:
                    i = html_link.index('"')
                    j = html_link.index('"', i + 1)
                except:
                    i = 0
                    j = len(html_link)
                # print(html_link[i + 1: j])
                cur['photo_info'] = html_link[i + 1: j]
            elif attr_name == 'hours':
                hrs = ''
                for h in attr:
                    hrs += h.replace('\\\\....', '') + '\n'
                cur['hours'] = hrs
            elif attr_name != 'place_id':
                cur[attr_name] = attr
            else:
                pass
        if len(l) and cur.keys() == l[-1].keys() or not len(l):
            l.append(cur)
    return l

def get_treatment_list(treatments):
    """Flatten raw treatment records into dicts matching the Treatment columns."""
    l = []
    for treatment in treatments:
        cur = {}
        for attr_name, attr in treatment.items():
            if type(attr) == list:
                name = 'locations_list' if attr_name.lower() in 'locations_list' else 'disorders_list'
                cur[name] = "~".join(attr)
            elif attr_name == 'Type':
                cur['treatment_type'] = attr
            elif attr_name != 'setid':
                cur[attr_name.lower()] = attr
        if len(l) and cur.keys() == l[-1].keys() or not len(l):
            l.append(cur)
    return l

def upload_data(table, data):
    """Bulk-insert a list of dicts into the given table."""
    stmt = sqla.insert(table)
    res = oc.session.execute(
        sqla.insert(table),
        data
    )
    oc.session.commit()

def delete_tables():
    """Drop every table so the database can be rebuilt from scratch."""
    print_all_tables()
    oc.Base.metadata.drop_all(oc.engine)
    print_all_tables()

def create_relationships(disorders_list, locations_list, treatments_list):
    """Build ORM objects for all three models and insert them in one commit."""
    disorders = []
    for disorder_args in disorders_list:
        args = {}
        # print(oc.Location.Location)
        for e in dir(oc.Disorder.Disorder):
            if e[0] != '-':
                for k in disorder_args.keys():
                    if e == k.lower() or e in k.lower() or k.lower() in e:
                        # print(f'putting {l[k]} in {e} for {l["name"]}')
                        args[e] = disorder_args[k]
                        break
                else:
                    args[e] = None
        # if disorder_args.keys() != disorders_list[0].keys():
        #     continue
        # print(disorder_args.keys())
        x = oc.Disorder.Disorder(
            name=disorder_args['name'],
            description=disorder_args['description'],
            image_url=disorder_args['image_url'],
            symptoms=disorder_args['symptoms'],
            causes=disorder_args['causes'],
            diagnosis=disorder_args['diagnosis'],
            treatment_attr=disorder_args['treatment_attr'],
            population_affected=disorder_args['population_affected'],
            treatments_list=disorder_args['treatments_list'],
            locations_list=disorder_args['locations_list'])
        disorders.append(x)

    locations = []
    for l in locations_list:
        # print(len(locations_list))
        args = {}
        # print(oc.Location.Location)
        for e in dir(oc.Location.Location):
            if e[0] != '-':
                for k in l.keys():
                    if e == k.lower() or e in k.lower() or k.lower() in e:
                        # print(f'putting {l[k]} in {e} for {l["name"]}')
                        args[e] = l[k]
                        break
                else:
                    args[e] = None

        x = oc.Location.Location(
            name=args['name'],
            address=args['address'],
            rating=args['rating'],
            num_ratings=args['num_ratings'],
            phone_number=args['phone_number'],
            hours=args['hours'],
            latitude=args['latitude'],
            longitude=args['longitude'],
            photo_info=args['photo_info'],
            treatments_list=args['treatments_list'],
            disorders_list=args['disorders_list'])
        
        locations.append(x)

    treatments = []
    for t in treatments_list:
        args = {}
        # print(oc.Location.Location)
        for e in dir(oc.Treatment.Treatment):
            if e[0] != '-':
                for k in t.keys():
                    if e == k.lower() or e in k.lower() or k.lower() in e:
                        # print(f'putting {l[k]} in {e} for {l["name"]}')
                        args[e] = t[k]
                        break
                else:
                    args[e] = None
        # print(t.keys())
        # if t.keys() != treatments_list[0].keys():
        #     continue

        x = oc.Treatment.Treatment(
            name=t['name'],
            title=t['title'],
            media=t['media'],
            url=t['url'],
            treatment_type=t['treatment_type'],
            description=t['description'],
            disorders_list=t['disorders_list'],
            locations_list=t['locations_list'])
        treatments.append(x)

    # for d_args, d in zip(disorders_list, disorders):
    #     for t in d_args['Treatments']:
    #         treatment = next((x for x in treatments if x.name == t), None)
    #         if treatment:
    #             d.treatments_list.append(treatment) 
    #     for l in d_args['Locations']:
    #         location = next((x for x in locations if x.name == l), None)
    #         if location:
    #             d.locations_list.append(location) 

    # for l_args, l in zip(locations_list, locations):
    #     for d in l_args['Disorders']:
    #         disorder = next((x for x in disorders if x.name == d), None)
    #         if disorder:
    #             l.disorders_list.append(disorder)
    #     for t in l_args['Treatments']:
    #         treatment = next((x for x in treatments if x.name == t), None)
    #         if treatment:
    #             l.disorders_list.append(treatment)

    # for t_args, t in zip(treatments_list, treatments):
    #     for d in t_args['Disorders']:
    #         disorder = next((x for x in disorders if x.name == d), None)
    #         if disorder:
    #             t.disorders_list.append(disorder)
    #     for l in t_args['Locations']:
    #         location = next((x for x in locations if x.name == l), None)
    #         if location:
    #             t.locations_list.append(location)

    oc.Base.metadata.create_all(oc.engine)

    for d in disorders:
        oc.session.add(d)
    for l in locations:
        oc.session.add(l)
    for t in treatments:
        oc.session.add(t)
    oc.session.commit()
    oc.session.flush()

def create_all_tables(do_relationships):
    """Create the tables, parse the JSON data and insert it."""
    print_all_tables()

    oc.Base.metadata.create_all(oc.engine)

    r = clean_disorders()
    disorders_list = get_disorders_list(r)

    r = clean_locations()
    print(f'length of r = {len(r)}')
    locations_list = get_locations_list(r)
    print(f'len of locations list {len(locations_list)}')

    r = clean_treatments()
    treatments_list = get_treatment_list(r)

    if do_relationships:
        create_relationships(disorders_list, locations_list, treatments_list)
    else:
        r = upload_data(oc.Disorder.Disorder, disorders_list)
        r = upload_data(oc.Location.Location, locations_list)
        r = upload_data(oc.Treatment.Treatment, treatments_list)
    
    oc.session.commit()
    oc.session.flush()
    # oc.session.rollback()
    print_all_tables()

    
    # create connections
    pass

def seed():
    """Rebuild the database from backend/data (drop, create, insert)."""
    oc.session = oc.session_maker()
    delete_tables()
    create_all_tables(True)


if __name__ == '__main__':
    # if len(sys.argv) < 3:
    #     do_relationships = False
    # elif sys.argv[2] == 'y':
    #     do_relationships = True
    # else:
    #     do_relationships = False

    seed()