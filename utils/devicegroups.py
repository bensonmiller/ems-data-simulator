import random
import re
from dataclasses import dataclass

@dataclass
class Device:
    manufacturer: str
    model: str
    pqs_code: str
    type: str

    @classmethod
    def from_dict(cls, device_dict):
        '''
        Create a Device instance from a dictionary. Automatically resolves
        the correct keys for manufacturer, model, and pqs_code based on the
        device type (fridges, rtmds, or dtrs).
        '''
        if 'AMFR' in device_dict:
            return cls(
                manufacturer=device_dict['AMFR'],
                model=device_dict['AMOD'],
                pqs_code=device_dict['APQS'],
                type=device_dict['type']
            )
        elif 'LMFR' in device_dict:
            return cls(
                manufacturer=device_dict['LMFR'],
                model=device_dict['LMOD'],
                pqs_code=device_dict['LPQS'],
                type=device_dict['type']
            )
        else:
            raise ValueError("Unknown device type: Unable to resolve keys.")

fridges = [
    {"APQS": "E003/002", "type": "Vaccine/Waterpacks freezer", "AMFR": "Qingdao Haier Biomedical Co., Ltd", "AMOD": "HBD 116"},
    {"APQS": "E003/003", "type": "Vaccine/Waterpacks freezer", "AMFR": "Qingdao Haier Biomedical Co., Ltd", "AMOD": "HBD 286"},
    {"APQS": "E003/007", "type": "Icelined refrigerator", "AMFR": "Vestfrost Solutions", "AMOD": "MK 304"},
    {"APQS": "E003/011", "type": "Icelined refrigerator", "AMFR": "Vestfrost Solutions", "AMOD": "MK 204"},
    {"APQS": "E003/022", "type": "Icelined refrigerator", "AMFR": "Vestfrost Solutions", "AMOD": "MK 144"},
    {"APQS": "E003/024", "type": "Vaccine/Waterpacks freezer", "AMFR": "Vestfrost Solutions", "AMOD": "MF 114"},
    {"APQS": "E003/025", "type": "Vaccine/Waterpacks freezer", "AMFR": "Vestfrost Solutions", "AMOD": "MF 214"},
    {"APQS": "E003/023", "type": "Vaccine/Waterpacks freezer", "AMFR": "Vestfrost Solutions", "AMOD": "MF 314"},
    {"APQS": "E003/035", "type": "Solar direct drive refrigerator/freezer", "AMFR": "B Medical Systems Sarl", "AMOD": "TCW 2000 SDD"},
    {"APQS": "E003/030", "type": "Solar direct drive refrigerator", "AMFR": "B Medical Systems Sarl", "AMOD": "TCW 3000 SDD"},
    {"APQS": "E003/048", "type": "Solar Direct Drive Combined Refrigerator/Freezer", "AMFR": "Dulas Ltd", "AMOD": "VC150SDD"},
    {"APQS": "E003/037", "type": "Solar direct drive refrigerator", "AMFR": "Zero Appliances Ltd", "AMOD": "ZLF 100 DC (SureChill ®)"},
    {"APQS": "E003/106", "type": "Solar direct drive refrigerator", "AMFR": "Vestfrost Solutions", "AMOD": "VLS 054A SDD"},
    {"APQS": "E003/043", "type": "Solar direct drive refrigerator/freezer", "AMFR": "B Medical Systems Sarl", "AMOD": "TCW 2043 SDD"},
    {"APQS": "E003/042", "type": "Solar direct drive refrigerator/freezer", "AMFR": "B Medical Systems Sarl", "AMOD": "TCW 40 SDD"},
    {"APQS": "E003/044", "type": "Icelined refrigerator", "AMFR": "Zero Appliances Ltd", "AMOD": "ZLF 150 AC (SureChill ®)"},
    {"APQS": "E003/045", "type": "Solar direct drive refrigerator", "AMFR": "B Medical Systems Sarl", "AMOD": "TCW 3043 SDD"},
    {"APQS": "E003/049", "type": "Solar Direct Drive Refrigerator", "AMFR": "Godrej & Boyce MFG. Co. Ltd.", "AMOD": "GVR 50DC SDD"},
    {"APQS": "E003/061", "type": "Vaccine/Waterpack freezer", "AMFR": "Qingdao Aucma Global Medical Co.,Ltd.", "AMOD": "DW-25W300"},
    {"APQS": "E003/050", "type": "Solar Direct Drive Refrigerator", "AMFR": "Godrej & Boyce MFG. Co. Ltd.", "AMOD": "GVR 100 DC (SureChill®)"},
    {"APQS": "E003/051", "type": "Ice-lined refrigerator", "AMFR": "Zero Appliances Ltd", "AMOD": "ZLF30 AC (SureChill ®)"},
    {"APQS": "E003/052", "type": "Solar direct drive refrigerator", "AMFR": "Zero Appliances Ltd", "AMOD": "ZLF 150 DC (SureChill ®)"},
    {"APQS": "E003/107", "type": "Solar direct drive refrigerator", "AMFR": "Vestfrost Solutions", "AMOD": "VLS 094A SDD"},
    {"APQS": "E003/108", "type": "Solar direct drive refrigerator", "AMFR": "Vestfrost Solutions", "AMOD": "VLS 154A SDD Greenline"},
    {"APQS": "E003/057", "type": "Solar Direct Drive Combined Refrigerator/Freezer", "AMFR": "Qingdao Haier Biomedical Co., Ltd", "AMOD": "HTCD-160-SDD"},
    {"APQS": "E003/055", "type": "Solar direct drive refrigerator", "AMFR": "Zero Appliances Ltd", "AMOD": "ZLF 30DC SDD (SureChill ®)"},
    {"APQS": "E003/058", "type": "Solar Direct Drive vaccine refrigerator", "AMFR": "Dulas Ltd", "AMOD": "Dulas VC110SDD"},
    {"APQS": "E003/059", "type": "Solar Direct Drive vaccine refrigerator", "AMFR": "Dulas Ltd", "AMOD": "VC88SDD"},
    {"APQS": "E003/040", "type": "Solar Direct Drive Refrigerator", "AMFR": "Dulas Ltd", "AMOD": "VC200SDD"},
    {"APQS": "E003/060", "type": "Vaccine/waterpack freezer", "AMFR": "Qingdao Aucma Global Medical Co.,Ltd.", "AMOD": "DW-25W147"},
    {"APQS": "E003/068", "type": "Solar Direct Drive refrigerator", "AMFR": "B Medical Systems Sarl", "AMOD": "TCW 40R SDD"},
    {"APQS": "E003/109", "type": "Mains-powered refrigerator", "AMFR": "Vestfrost Solutions", "AMOD": "VLS 204A"},
    {"APQS": "E003/066", "type": "Icelined refrigerator", "AMFR": "B Medical Systems Sarl", "AMOD": "TCW 4000 AC"},
    {"APQS": "E003/073", "type": "Solar Direct Drive Waterpacks Freezer", "AMFR": "B Medical Systems Sarl", "AMOD": "TFW 40 SDD"},
    {"APQS": "E003/110", "type": "Icelined refrigerator", "AMFR": "Vestfrost Solutions", "AMOD": "VLS 304A AC"},
    {"APQS": "E003/111", "type": "Icelined refrigerator", "AMFR": "Vestfrost Solutions", "AMOD": "VLS 354A AC"},
    {"APQS": "E003/112", "type": "Icelined refrigerator", "AMFR": "Vestfrost Solutions", "AMOD": "VLS 404A AC"},
    {"APQS": "E003/069", "type": "Solar direct drive refrigerator", "AMFR": "Vestfrost Solutions", "AMOD": "VLS 024 SDD"},
    {"APQS": "E003/070", "type": "Combined icelined refrigerator/waterpacks freezer", "AMFR": "Vestfrost Solutions", "AMOD": "VLS 064 RF AC"},
    {"APQS": "E003/067", "type": "Solar direct drive refrigerator", "AMFR": "B Medical Systems Sarl", "AMOD": "TCW 15R SDD"},
    {"APQS": "E003/071", "type": "Waterpacks freezer", "AMFR": "B Medical Systems Sarl", "AMOD": "TFW 3000 AC"},
    {"APQS": "E003/072", "type": "Icelined refrigerator", "AMFR": "Dulas Ltd", "AMOD": "VC225ILR"},
    {"APQS": "E003/075", "type": "Solar direct drive refrigerator", "AMFR": "Qingdao Haier Biomedical Co., Ltd", "AMOD": "HTC 40 SDD"},
    {"APQS": "E003/076", "type": "Solar direct drive refrigerator", "AMFR": "Qingdao Haier Biomedical Co., Ltd", "AMOD": "HTC 110 SDD"},
    {"APQS": "E003/074", "type": "Solar direct drive refrigerator/freezer", "AMFR": "Qingdao Haier Biomedical Co., Ltd", "AMOD": "HTCD 90 SDD"},
    {"APQS": "E003/079", "type": "Icelined refrigerator", "AMFR": "Qingdao Aucma Global Medical Co.,Ltd.", "AMOD": "CFD-50"},
    {"APQS": "E003/077", "type": "Solar Direct Drive Refrigerator and Freezer", "AMFR": "B Medical Systems Sarl", "AMOD": "TCW15 SDD"},
    {"APQS": "E003/078", "type": "Solar Direct Drive refrigerator", "AMFR": "Dulas Ltd", "AMOD": "VC50SDD"},
    {"APQS": "E003/080", "type": "Ice-lined refrigerator", "AMFR": "Godrej & Boyce MFG. Co. Ltd.", "AMOD": "GVR 51 LITE AC"},
    {"APQS": "E003/081", "type": "Ice-lined refrigerator", "AMFR": "Godrej & Boyce MFG. Co. Ltd.", "AMOD": "GVR 75 Lite"},
    {"APQS": "E003/082", "type": "Ice-lined refrigerator", "AMFR": "Godrej & Boyce MFG. Co. Ltd.", "AMOD": "GVR 99 Lite"},
    {"APQS": "E003/083", "type": "Ice-lined refrigerator", "AMFR": "Godrej & Boyce MFG. Co. Ltd.", "AMOD": "GVR 225 AC"},
    {"APQS": "E003/084", "type": "Solar Direct Drive refrigerator", "AMFR": "Dulas Ltd", "AMOD": "VC60SDD-1"},
    {"APQS": "E003/085", "type": "Solar Direct Drive Refrigerator", "AMFR": "Dulas Ltd", "AMOD": "VC30SDD"},
    {"APQS": "E003/086", "type": "Solar Direct Drive Waterpacks Freezer", "AMFR": "Qingdao Haier Biomedical Co., Ltd", "AMOD": "HTD-40"},
    {"APQS": "E003/087", "type": "Ice-lined Refrigerator", "AMFR": "Qingdao Haier Biomedical Co., Ltd", "AMOD": "HBC-260"},
    {"APQS": "E003/088", "type": "Ice-lined Refrigerator", "AMFR": "Qingdao Haier Biomedical Co., Ltd", "AMOD": "HBC-150"},
    {"APQS": "E003/089", "type": "Ice-lined Refrigerator", "AMFR": "Qingdao Haier Biomedical Co., Ltd", "AMOD": "HBC-80"},
    {"APQS": "E003/090", "type": "Solar Direct Drive Refrigerator", "AMFR": "B Medical Systems Sarl", "AMOD": "Ultra 16 SDD"},
    {"APQS": "E003/091", "type": "Solar Direct Drive Refrigerator and Freezer", "AMFR": "Vestfrost Solutions", "AMOD": "VLS 026 RF SDD"},
    {"APQS": "E003/092", "type": "Solar Direct Drive Refrigerator and Freezer", "AMFR": "Vestfrost Solutions", "AMOD": "VLS 056 RF SDD"},
    {"APQS": "E003/093", "type": "Solar Direct Drive Refrigerator", "AMFR": "B Medical Systems Sarl", "AMOD": "TCW 4000 SDD"},
    {"APQS": "E003/095", "type": "Solar Direct Drive Refrigerator and Freezer", "AMFR": "Godrej & Boyce MFG. Co. Ltd.", "AMOD": "GVR 55 FF DC"},
    {"APQS": "E003/113", "type": "Ice-lined Refrigerator", "AMFR": "Vestfrost Solutions", "AMOD": "VLS 504A AC"},
    {"APQS": "E003/096", "type": "Ice-lined Refrigerator", "AMFR": "Zero Appliances Ltd", "AMOD": "ZLF80AC (SureChill®)"},
    {"APQS": "E003/097", "type": "Combined Refrigerator and waterpack freezer", "AMFR": "Qingdao Haier Biomedical Co., Ltd", "AMOD": "HBCD-90"},
    {"APQS": "E003/098", "type": "Solar Direct Drive Refrigerator", "AMFR": "Qingdao Aucma Global Medical Co.,Ltd.", "AMOD": "CFD-50 SDD"},
    {"APQS": "E003/099", "type": "Solar Direct Drive Waterpacks Freezer", "AMFR": "Vestfrost Solutions", "AMOD": "VFS 048 SDD"},
    {"APQS": "E003/100", "type": "Ice-lined Refrigerator", "AMFR": "B Medical Systems Sarl", "AMOD": "TCW 40R AC"},
    {"APQS": "E003/101", "type": "Ice-lined Refrigerator", "AMFR": "B Medical Systems Sarl", "AMOD": "TCW 80 AC"},
    {"APQS": "E003/102", "type": "Solar Direct Drive Refrigerator", "AMFR": "Qingdao Haier Biomedical Co., Ltd", "AMOD": "HTC-112"},
    {"APQS": "E003/103", "type": "Combined Refrigerator and Waterpack Freezer", "AMFR": "Godrej & Boyce MFG. Co. Ltd.", "AMOD": "GVR 55 FF AC"},
    {"APQS": "E003/114", "type": "Ice-lined Refrigerator", "AMFR": "Qingdao Haier Biomedical Co., Ltd", "AMOD": "HBC-120"},
    {"APQS": "E003/115", "type": "Ice-lined Refrigerator", "AMFR": "Qingdao Haier Biomedical Co., Ltd", "AMOD": "HBC-240"},
    {"APQS": "E003/116", "type": "Solar Direct Drive Refrigerator", "AMFR": "Qingdao Haier Biomedical Co., Ltd", "AMOD": "HTC-120-SDD"},
    {"APQS": "E003/117", "type": "Solar Direct Drive Refrigerator", "AMFR": "Qingdao Haier Biomedical Co., Ltd", "AMOD": "HTC-240-SDD"},
    {"APQS": "E003/118", "type": "Solar Direct Drive Refrigerator", "AMFR": "Qingdao Aucma Global Medical Co.,Ltd.", "AMOD": "ARKTEK YBC-10 SDD"},
    {"APQS": "E003/119", "type": "Solar Direct Drive Refrigerator/Water pack freezer", "AMFR": "Vestfrost Solutions", "AMOD": "VLS 076 RF SDD"},
    {"APQS": "E003/120", "type": "Icelined refrigerator", "AMFR": "Vestfrost Solutions", "AMOD": "VLS 174A AC"},
    {"APQS": "E003/121", "type": "Solar Direct Drive Refrigerator", "AMFR": "B Medical Systems Sarl", "AMOD": "TCW80-SDD"},
    {"APQS": "E003/122", "type": "Icelined refrigerator", "AMFR": "Coolfinity Medical B.V.", "AMOD": "IceVolt 300P"},
    {"APQS": "E003/123", "type": "Combined Icelined Refrigerator & Freezer", "AMFR": "B Medical Systems Sarl", "AMOD": "TCW120AC"},
    {"APQS": "E003/124", "type": "Vaccine Refrigerator / Ice-pack Freezer", "AMFR": "B Medical Systems Sarl", "AMOD": "TCW120SDD"},
    {"APQS": "E003/125", "type": "Vaccine Freezer - Ultralow Temperature Storage", "AMFR": "B Medical Systems Sarl", "AMOD": "U201"},
    {"APQS": "E003/126", "type": "Vaccine/Waterpacks Freezer", "AMFR": "Qingdao Haier Biomedical Co., Ltd", "AMOD": "HBD-86"},
    {"APQS": "E003/127", "type": "Vaccine/Waterpack Freezer", "AMFR": "Western Refrigeration Private Limited", "AMOD": "VFW140H-HC"},
    {"APQS": "E003/128", "type": "Vaccine/Waterpacks Freezer", "AMFR": "Western Refrigeration Private Limited", "AMOD": "VFW310H-HC"},
    {"APQS": "E003/129", "type": "Solar Direct Drive Refrigerator & Freezer", "AMFR": "Qingdao Aucma Global Medical Co.,Ltd.", "AMOD": "TCD-100"},
    {"APQS": "E003/130", "type": "Vaccine/waterpaks freezer", "AMFR": "Godrej & Boyce MFG. Co. Ltd.", "AMOD": "GMF 200 ECO lite"},
    {"APQS": "E003/132", "type": "Solar Direct Drive Refrigerator/Water pack freezer", "AMFR": "Vestfrost Solutions", "AMOD": "VLS 096A RF SDD"},
    {"APQS": "E003/131", "type": "Combined icelined refrigerator/waterpaks freezer", "AMFR": "Qingdao Haier Biomedical Co., Ltd", "AMOD": "HBD265"},
    {"APQS": "E003/133", "type": "Icelined refrigerator", "AMFR": "Western Refrigeration Private Limited", "AMOD": "I425H120"},
    {"APQS": "E003/134", "type": "Transportable vaccine storage device - Lightweight", "AMFR": "BlackFrog Technologies Private Limited", "AMOD": "Emvolio Plus"},
    {"APQS": "E003/135", "type": "Solar Direct Drive Refrigerator", "AMFR": "Qingdao Haier Biomedical Co., Ltd", "AMOD": "HTCD-160B"},
    {"APQS": "E003/136", "type": "IceLined Refrigerator", "AMFR": "Godrej & Boyce MFG. Co. Ltd.", "AMOD": "GHR 200 AC"},
    {"APQS": "E003/137", "type": "Icelined Refrigerator", "AMFR": "Godrej & Boyce MFG. Co. Ltd.", "AMOD": "GHR 90 AC"}
]

dtrs = [
    {"LPQS":"E006/020", "type": "30 day electronic temperature logger","LMFR":"Berlinger & Co. AG", "LMOD":"Fridge-tag 2"},
    {"LPQS":"E006/040", "type": "30-day electronic temperature logger","LMFR":"Berlinger & Co. AG", "LMOD":"Fridge-tag 2 E"},
    {"LPQS":"E006/093", "type": "30-Day Electronic Temperature logger","LMFR":"Berlinger & Co. AG", "LMOD":"Fridge-tag 2L"},
    {"LPQS":"E006/069", "type": "User Programable data logger","LMFR":"Parsyl Inc.", "LMOD":"Trek Pro"},
    {"LPQS":"E006/042", "type": "30-day electronic temperature logger","LMFR":"Qingdao Haier Biomedical Co., Ltd", "LMOD":"HETL-01"},
    {"LPQS":"E006/081", "type": "30 Day Temperature Logger","LMFR":"G-Tek Corporation Private Limited", "LMOD":"LM-XS Pro E006"},
    {"LPQS":"E006/041", "type": "Remote Temperature Monitoring Device","LMFR":"Berlinger & Co. AG", "LMOD":"Fridge-tag 3 without SIM card"}
]

rtmds = [
    {"LPQS":"E006/019", "type": "Remote Temperature Monitoring Device","LMFR":"Berlinger & Co. AG", "LMOD":"SmartLine"},
    {"LPQS":"E006/087", "type": "Remote Temperature Monitoring Device","LMFR":"Berlinger & Co. AG", "LMOD":"SmartMonitor SITE L"},
    {"LPQS":"E006/036", "type": "Remote Temperature Monitoring Device","LMFR":"Beyond Wireless Technology Ltd", "LMOD":"ICE3 - Model BC141"},
    {"LPQS":"E006/037", "type": "Remote Temperature Monitoring Device","LMFR":"Beyond Wireless Technology Ltd", "LMOD":"Ice3-Extra-BC440"},
    {"LPQS":"E006/039", "type": "Remote Temperature Monitoring Device","LMFR":"Nexleaf Analytics", "LMOD":"ColdTrace 5"},
    {"LPQS":"E006/091", "type": "Remote Temperature Monitoring System","LMFR":"Nexleaf Analytics", "LMOD":"CTX"},
    {"LPQS":"E006/048", "type": "Remote Temperature Monitoring Device","LMFR":"Blulog Sp. z o.o", "LMOD":"Blulog"},
    {"LPQS":"E006/055", "type": "Remote Temperature Monitoring Device","LMFR":"Zero Appliances Ltd", "LMOD":"Stat-Send"},
    {"LPQS":"E006/061", "type": "Remote Temperature Monitoring Device","LMFR":"IKHAYA Automation systems", "LMOD":"VM1000"},
    {"LPQS":"E006/060", "type": "Remote Temperature Monitoring Device","LMFR":"Qingdao Haier Biomedical Co., Ltd", "LMOD":"Haier U-Cool"},
    {"LPQS":"E006/075", "type": "Remote Temperature Monitoring Device","LMFR":"Qingdao Haier Biomedical Co., Ltd", "LMOD":"U-COOL-LORA"},
    {"LPQS":"E006/078", "type": "Remote Temperature Monitoring Device","LMFR":"Qingdao Haier Biomedical Co., Ltd", "LMOD":"U-COOL Pro"},
    {"LPQS":"E006/080", "type": "Remote Temperature Monitoring Device","LMFR":"Parsyl Inc.", "LMOD":"Parsyl Trek Pro & Gateway"}
]

class DeviceGroup():
    def __init__(self, device_list) -> None:
        '''
        Initialize a DeviceGroup with a list of devices.
        
        For example:
            dg = DeviceGroup(fridges)
          
        or
            dg = DeviceGroup(rtmds)
        '''
        self.devices = device_list
        self.manufacturer_key = self._resolve_manufacturer_key()

    def _resolve_manufacturer_key(self):
        '''
        Determine the key to use for the manufacturer. This is necessary 
        because the key is different for fridges, DTRs, and RTMDs (e.g., AMFR vs. LMFR).
        '''
        self.manufacturer_key = 'AMFR' if 'AMFR' in self.devices[0] else 'LMFR'
        return self.manufacturer_key

    def random_device(self, manufacturer=None):
        '''
        Return metadata for a random device. If manufacturer is specified,
        return a random device from that manufacturer.
        '''
        if manufacturer is None:
            devices = self.devices
        else:
            devices = self.get_manufacturer_group(manufacturer)
            if len(devices) == 0:
                print(f"Manufacturer {manufacturer} not found. Selecting randomly.")
                devices = self.devices
    
        return Device.from_dict(random.choice(devices))
    
    def list(self):
        '''Return a list of all devices'''
        return self.devices
    
    def group_by_manufacturer(self):
        '''Return a dictionary of devices grouped by manufacturer'''
        key = self.manufacturer_key
        return {dev[key]: [d for d in self.devices if d[key] == dev[key]] for dev in self.devices}

    def get_random_manufacturer(self):
        '''Return a random manufacturer name'''
        return random.choice(list(self.group_by_manufacturer().keys()))
                             
    def get_manufacturer_group(self, manufacturer=None):
        '''
        Return a list of devices from a specified manufacturer (regex
        matching). Otherwise, select a random manufacturer and return
        the corresponding device group.
        '''
        group = self.group_by_manufacturer()
        if manufacturer is None:
            manufacturer = random.choice(list(group.keys()))
        else:
            prog = re.compile(manufacturer, re.IGNORECASE)
            manufacturers = [m for m in group.keys() if prog.search(m)]
            manufacturer = random.choice(manufacturers)

        return group[manufacturer]
